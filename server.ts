import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import { db } from './server/db';
import { Position, PitchType } from './src/types';

// Extend Express Request type to include user data
interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
}

const JWT_SECRET = process.env.JWT_SECRET || 'football-matchmaker-super-secret-key-2026';
const PORT = 3000;

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  
  // Set up Socket.io
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
  });

  // Middleware
  app.use(express.json());

  // Helper to broadcast room updates
  const broadcastRoomUpdate = (roomId: string, data: any) => {
    io.to(`room_${roomId}`).emit('room_updated', data);
    // Also notify global lobby about changes to room counts/state
    io.emit('global_rooms_updated');
  };

  // --- AUTHENTICATION MIDDLEWARE ---
  function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Acceso no autorizado. Token faltante.' });
    }

    jwt.verify(token, JWT_SECRET, (err: any, decoded: any) => {
      if (err) {
        return res.status(403).json({ error: 'Sesión expirada o token inválido.' });
      }
      req.user = decoded as { id: string; email: string };
      next();
    });
  }

  // --- API ENDPOINTS ---

  // 1. Auth: Register
  app.post('/api/auth/register', (req: Request, res: Response) => {
    try {
      const { email, password, name, preferredPosition, department, province, district } = req.body;

      if (!email || !password || !name || !preferredPosition) {
        return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
      }

      const validPositions: Position[] = ['GK', 'DEF', 'MID', 'FWD'];
      if (!validPositions.includes(preferredPosition)) {
        return res.status(400).json({ error: 'Posición preferida no válida.' });
      }

      const user = db.createUser(email, password, name, preferredPosition, department, province, district);
      const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

      return res.status(201).json({ user, token });
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  // 2. Auth: Login
  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Correo y contraseña requeridos.' });
      }

      const user = await db.getUserByEmail(email);
      if (!user) {
        return res.status(401).json({ error: 'Credenciales incorrectas.' });
      }

      // Check password
      const passwordMatch = bcrypt.compareSync(password, user.passwordHash);
      if (!passwordMatch) {
        return res.status(401).json({ error: 'Credenciales incorrectas.' });
      }

      const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
      const { passwordHash: _, ...userWithoutPassword } = user;

      return res.json({ user: userWithoutPassword, token });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // 3. Get Player Profile
  app.get('/api/profile', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const user = await db.ensureUserLoaded(userId);
      if (!user) {
        return res.status(404).json({ error: 'Perfil no encontrado.' });
      }
      return res.json(user);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // 4. Update Player Profile
  app.put('/api/profile', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { name, preferredPosition, department, province, district } = req.body;

      if (!name || !preferredPosition) {
        return res.status(400).json({ error: 'Nombre y posición preferida requeridos.' });
      }

      const validPositions: Position[] = ['GK', 'DEF', 'MID', 'FWD'];
      if (!validPositions.includes(preferredPosition)) {
        return res.status(400).json({ error: 'Posición preferida no válida.' });
      }

      // Ensure user is loaded in local cache first
      await db.ensureUserLoaded(userId);

      const updatedUser = db.updateUserProfile(userId, name, preferredPosition, department, province, district);
      
      // Notify active rooms where user belongs
      const rooms = db.getRooms();
      rooms.forEach((room) => {
        if (room.players.includes(userId)) {
          // If the match hasn't started, we rebalance teams because position or SR might have changed!
          if (room.state === 'lobby') {
            const reloadedRoom = db.joinRoom(room.id, userId); // Running joinRoom again handles rebalance safely
            broadcastRoomUpdate(room.id, reloadedRoom);
          }
        }
      });

      return res.json(updatedUser);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  // 5. Get Rooms (Match List) with recommended filters
  app.get('/api/rooms', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const user = await db.ensureUserLoaded(userId);
      
      const rooms = db.getRooms();
      
      // Add a recommended ranking metadata to each room for the player
      const roomsWithRecommendations = rooms.map((room) => {
        let isRecommended = false;
        let skillMatchScore = 100; // Perfect match default

        if (user) {
          const srDiff = Math.abs(room.expectedSR - user.skillRating);
          // If expected SR of the room is within 250 points of user's SR, recommend it!
          if (srDiff <= 250) {
            isRecommended = true;
          }
          skillMatchScore = Math.max(0, 100 - Math.round(srDiff / 10)); // Higher score = closer match
        }

        return {
          ...room,
          isRecommended,
          skillMatchScore,
        };
      });

      // Sort: Recommended first, then by skill match score, then by creation date
      roomsWithRecommendations.sort((a, b) => {
        if (a.state !== 'lobby' && b.state === 'lobby') return 1;
        if (a.state === 'lobby' && b.state !== 'lobby') return -1;
        if (a.isRecommended && !b.isRecommended) return -1;
        if (!a.isRecommended && b.isRecommended) return 1;
        return b.skillMatchScore - a.skillMatchScore;
      });

      return res.json(roomsWithRecommendations);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // 6. Create Room
  app.post('/api/rooms', authenticateToken, (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { title, date, time, pitchType, maxPlayers, expectedSR, department, province, district, mapsUrl } = req.body;

      if (!title || !date || !time || !pitchType || !maxPlayers || !expectedSR) {
        return res.status(400).json({ error: 'Todos los campos son requeridos para crear la sala.' });
      }

      // Validar que la fecha y hora no sean del pasado (GMT-5 / America/Lima)
      const now = new Date();
      const optionsDate = { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' } as const;
      const optionsTime = { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false } as const;

      const formatterDate = new Intl.DateTimeFormat('en-US', optionsDate);
      const partsDate = formatterDate.formatToParts(now);
      const y = partsDate.find(p => p.type === 'year')!.value;
      const m = partsDate.find(p => p.type === 'month')!.value;
      const d = partsDate.find(p => p.type === 'day')!.value;
      const serverTodayStr = `${y}-${m}-${d}`;

      const formatterTime = new Intl.DateTimeFormat('en-US', optionsTime);
      const partsTime = formatterTime.formatToParts(now);
      const hh = partsTime.find(p => p.type === 'hour')!.value;
      const mm = partsTime.find(p => p.type === 'minute')!.value;
      const serverTimeStr = `${hh}:${mm}`;

      if (date < serverTodayStr) {
        return res.status(400).json({ error: 'La fecha del partido no puede ser anterior al día de hoy.' });
      }

      if (date === serverTodayStr && time < serverTimeStr) {
        return res.status(400).json({ error: 'La hora del partido ya ha pasado hoy. Elige una hora futura.' });
      }

      const validPitches: PitchType[] = ['5v5', '7v7', '11v11'];
      if (!validPitches.includes(pitchType)) {
        return res.status(400).json({ error: 'Tipo de cancha no válido.' });
      }

      const maxPlayersLimit = pitchType === '5v5' ? 10 : pitchType === '7v7' ? 14 : 22;
      if (maxPlayers > maxPlayersLimit) {
        return res.status(400).json({ error: `El número máximo de jugadores para ${pitchType} es ${maxPlayersLimit}.` });
      }

      const room = db.createRoom(
        title,
        userId,
        date,
        time,
        pitchType,
        maxPlayers,
        expectedSR,
        department,
        province,
        district,
        mapsUrl
      );
      io.emit('global_rooms_updated'); // Notify lobby about a new room

      return res.status(201).json(room);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  // 7. Get single room details with player information populated
  app.get('/api/rooms/:id', authenticateToken, async (req: Request, res: Response) => {
    try {
      const roomId = req.params.id;
      const room = await db.ensureRoomLoaded(roomId);
      if (!room) {
        return res.status(404).json({ error: 'Sala no encontrada.' });
      }

      // Populate players info
      const playersDetailedPromises = room.players.map(pid => db.ensureUserLoaded(pid));
      const playersDetailed = (await Promise.all(playersDetailedPromises)).filter(Boolean);

      return res.json({
        ...room,
        playersDetailed,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // 8. Join Room
  app.post('/api/rooms/:id/join', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roomId = req.params.id;
      const userId = req.user!.id;

      await db.ensureRoomLoaded(roomId);
      await db.ensureUserLoaded(userId);

      const room = db.joinRoom(roomId, userId);
      
      // Populate details for the broadcast
      const playersDetailedPromises = room.players.map(pid => db.ensureUserLoaded(pid));
      const playersDetailed = (await Promise.all(playersDetailedPromises)).filter(Boolean);
      const updatedData = { ...room, playersDetailed };
      
      broadcastRoomUpdate(roomId, updatedData);

      return res.json(updatedData);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  // 9. Leave Room
  app.post('/api/rooms/:id/leave', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roomId = req.params.id;
      const userId = req.user!.id;

      await db.ensureRoomLoaded(roomId);
      await db.ensureUserLoaded(userId);

      const room = db.leaveRoom(roomId, userId);
      
      if (room === null) {
        // Room was deleted because it's now empty
        io.emit('global_rooms_updated');
        return res.json({ status: 'deleted' });
      }

      // Populate details
      const playersDetailedPromises = room.players.map(pid => db.ensureUserLoaded(pid));
      const playersDetailed = (await Promise.all(playersDetailedPromises)).filter(Boolean);
      const updatedData = { ...room, playersDetailed };

      broadcastRoomUpdate(roomId, updatedData);

      return res.json(updatedData);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  // 9b. Delete Room (called by Room Creator)
  app.post('/api/rooms/:id/delete', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roomId = req.params.id;
      const userId = req.user!.id;

      await db.ensureRoomLoaded(roomId);

      db.deleteRoom(roomId, userId);

      // Emit room_deleted event to notify all connected clients in this room to exit
      io.to(`room_${roomId}`).emit('room_deleted', { roomId });
      io.emit('global_rooms_updated');

      return res.json({ success: true });
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  // 9c. Fill room with Bots (called by Room Creator)
  app.post('/api/rooms/:id/fill-bots', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roomId = req.params.id;
      const userId = req.user!.id;

      await db.ensureRoomLoaded(roomId);

      const room = db.fillRoomWithBots(roomId, userId);

      // Add system message to chat
      db.addMessage(roomId, 'system', 'Sistema', `🤖 El organizador ha llenado la sala con jugadores de prueba.`);

      // Populate details
      const playersDetailedPromises = room.players.map(pid => db.ensureUserLoaded(pid));
      const playersDetailed = (await Promise.all(playersDetailedPromises)).filter(Boolean);
      const updatedData = { ...room, playersDetailed };

      broadcastRoomUpdate(roomId, updatedData);

      // Trigger message update in room
      const messages = db.getRoomMessages(roomId);
      io.to(`room_${roomId}`).emit('chat_message', messages[messages.length - 1]);

      return res.json(updatedData);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  // 10. Start Match
  app.post('/api/rooms/:id/start', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roomId = req.params.id;
      const userId = req.user!.id;

      await db.ensureRoomLoaded(roomId);

      const room = db.startMatch(roomId, userId);

      // Populate details
      const playersDetailedPromises = room.players.map(pid => db.ensureUserLoaded(pid));
      const playersDetailed = (await Promise.all(playersDetailedPromises)).filter(Boolean);
      const updatedData = { ...room, playersDetailed };

      broadcastRoomUpdate(roomId, updatedData);

      return res.json(updatedData);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  // 11. Propose Match Score (called by Room Creator)
  app.post('/api/rooms/:id/finish', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roomId = req.params.id;
      const userId = req.user!.id;
      const { scoreA, scoreB } = req.body;

      if (scoreA === undefined || scoreB === undefined || scoreA < 0 || scoreB < 0) {
        return res.status(400).json({ error: 'Goles válidos requeridos (debe ser mayor o igual a 0).' });
      }

      await db.ensureRoomLoaded(roomId);

      const room = db.proposeMatchScore(roomId, userId, Number(scoreA), Number(scoreB));

      // Add system message to chat
      db.addMessage(roomId, 'system', 'Sistema', `📝 El organizador ha propuesto un resultado de ${scoreA} - ${scoreB}. Esperando aprobación.`);

      // Populate details
      const playersDetailedPromises = room.players.map(pid => db.ensureUserLoaded(pid));
      const playersDetailed = (await Promise.all(playersDetailedPromises)).filter(Boolean);
      const updatedData = { ...room, playersDetailed };

      broadcastRoomUpdate(roomId, updatedData);

      // Trigger message update in room
      const messages = db.getRoomMessages(roomId);
      io.to(`room_${roomId}`).emit('chat_message', messages[messages.length - 1]);

      return res.json(updatedData);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  // 11b. Approve proposed score (called by Opposing Captain)
  app.post('/api/rooms/:id/approve', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roomId = req.params.id;
      const userId = req.user!.id;

      await db.ensureRoomLoaded(roomId);

      const room = db.approveMatchScore(roomId, userId);

      // Add system message to chat
      db.addMessage(roomId, 'system', 'Sistema', `🏆 ¡Resultado de ${room.scoreA} - ${room.scoreB} aprobado por ambos capitanes! El SR de los jugadores ha sido reajustado.`);

      // Populate details
      const playersDetailedPromises = room.players.map(pid => db.ensureUserLoaded(pid));
      const playersDetailed = (await Promise.all(playersDetailedPromises)).filter(Boolean);
      const updatedData = { ...room, playersDetailed };

      broadcastRoomUpdate(roomId, updatedData);

      // Trigger message update in room
      const messages = db.getRoomMessages(roomId);
      io.to(`room_${roomId}`).emit('chat_message', messages[messages.length - 1]);

      return res.json(updatedData);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  // 11c. Reject proposed score (called by Opposing Captain or Creator to cancel)
  app.post('/api/rooms/:id/reject', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roomId = req.params.id;
      const userId = req.user!.id;

      await db.ensureRoomLoaded(roomId);

      const room = db.rejectMatchScore(roomId, userId);

      // Add system message to chat
      db.addMessage(roomId, 'system', 'Sistema', `⚠️ El resultado propuesto ha sido rechazado. El organizador puede ingresar un resultado correcto.`);

      // Populate details
      const playersDetailedPromises = room.players.map(pid => db.ensureUserLoaded(pid));
      const playersDetailed = (await Promise.all(playersDetailedPromises)).filter(Boolean);
      const updatedData = { ...room, playersDetailed };

      broadcastRoomUpdate(roomId, updatedData);

      // Trigger message update in room
      const messages = db.getRoomMessages(roomId);
      io.to(`room_${roomId}`).emit('chat_message', messages[messages.length - 1]);

      return res.json(updatedData);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  // 12. Get Room Messages
  app.get('/api/rooms/:id/messages', authenticateToken, async (req: Request, res: Response) => {
    try {
      await db.ensureRoomLoaded(req.params.id);
      const messages = db.getRoomMessages(req.params.id);
      return res.json(messages);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // 13. Get Player Match History
  app.get('/api/history', authenticateToken, (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const history = db.getPlayerHistory(userId);
      return res.json(history);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // 13b. AI Coach Performance Analysis (Personal Coach)
  app.get('/api/ai-coach', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const user = await db.ensureUserLoaded(userId);
      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado.' });
      }

      const history = db.getPlayerHistory(userId);
      
      // Local fallback builder for bulletproof reliability
      const getFallback = () => {
        const positionName = {
          GK: 'Portero (Arquero)',
          DEF: 'Defensa (Zaguero)',
          MID: 'Mediocampista (Volante)',
          FWD: 'Delantero (Atacante)',
        }[user.preferredPosition as Position] || 'Futbolista';

        const sr = user.skillRating;
        const wins = user.wins || 0;
        const losses = user.losses || 0;
        const total = user.matchesPlayed || 0;
        const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

        let playstyleBadge = 'Estratega del Tablero';
        let tacticalSummary = `Análisis táctico para ${user.name}: Registras un Skill Rating de ${sr} y una tasa de victorias del ${winRate}% en ${total} partidos oficiales en la posición de ${positionName}.`;
        let strengths: string[] = [];
        let weaknesses: string[] = [];
        let tips: string[] = [];
        let drills: { name: string; description: string; duration: string }[] = [];

        if (user.preferredPosition === 'GK') {
          playstyleBadge = sr > 1200 ? 'Cerrojo Inquebrantable' : 'Guardián del Arco';
          tacticalSummary += ' Destacas por mantener buena colocación bajo los tres palos. Sin embargo, para escalar a categorías superiores, es vital dominar el juego aéreo en balones parados y mejorar la salida rápida con el pie.';
          strengths = ['Reflejos agudos en remates a quemarropa', 'Liderazgo verbal para organizar la defensa'];
          weaknesses = ['Salidas de puños en centros llovidos', 'Precisión en despejes largos con presión rival'];
          tips = [
            'Anticipa la jugada dando un pequeño paso hacia adelante para achicar el ángulo justo antes del remate.',
            'Mantén una comunicación constante con tus centrales para indicarles quién toma las marcas en contragolpes.'
          ];
          drills = [
            { name: 'Achique y Reacción Rápida', description: 'Realiza desplazamientos laterales rápidos seguidos de atajadas a corta distancia.', duration: '15 mins' },
            { name: 'Distribución Bajo Presión', description: 'Recibe pases rasos retrasados de tus defensas y distribuye de primera a los costados.', duration: '20 mins' }
          ];
        } else if (user.preferredPosition === 'DEF') {
          playstyleBadge = sr > 1200 ? 'Muralla Táctica' : 'Defensor Férreo';
          tacticalSummary += ' Eres un jugador sólido en duelos individuales de 1v1 y posees buena lectura de intercepción. Tu principal área de crecimiento es mejorar la salida limpia y evitar comprometerte rápido ante amagues de atacantes veloces.';
          strengths = ['Excelente juego aéreo ofensivo y defensivo', 'Timing preciso para intercepciones limpias'];
          weaknesses = ['Velocidad de retroceso ante pelotazos profundos', 'Salida limpia con el balón bajo presión intensa'];
          tips = [
            'No intentes quitar el balón al primer amague; temporiza, mantén la distancia y aguanta al atacante.',
            'Orienta tu cuerpo de perfil hacia la banda antes de recibir para facilitar un pase de salida seguro.'
          ];
          drills = [
            { name: 'Sombra Táctica y Temporización', description: 'Aguanta la marca a un atacante rápido en un espacio de 10x10 metros obligándolo a ir hacia afuera.', duration: '15 mins' },
            { name: 'Control Orientado y Salida Rápida', description: 'Recibe el balón simulando presión de espaldas, gira hacia el perfil libre y descarga a banda.', duration: '20 mins' }
          ];
        } else if (user.preferredPosition === 'MID') {
          playstyleBadge = sr > 1200 ? 'Metrónomo del Campo' : 'Motor del Equipo';
          tacticalSummary += ' Actúas como el eje de conexión del equipo en transiciones de defensa a ataque. Tu visión es valiosa, pero puedes incrementar tu impacto recuperando más balones en zona media y perfeccionando tus remates desde fuera del área.';
          strengths = ['Visión panorámica para pases filtrados de gol', 'Excelente control orientado para eludir marcas en zona congestionada'];
          weaknesses = ['Transición defensiva y repliegue rápido', 'Tasa de efectividad en disparos de media distancia'];
          tips = [
            'Realiza un \"escaneo de hombros\" (girar la cabeza para ver tus espaldas) cada 3 segundos antes de recibir.',
            'Dosifica tus esfuerzos de ida y vuelta para no quedar descolocado durante contragolpes letales.'
          ];
          drills = [
            { name: 'El Cuadrado del Escaneo', description: 'Recibe pases en un cuadrado de 5x5 metros y descárgalo rápido hacia el compañero libre previamente escaneado.', duration: '15 mins' },
            { name: 'Control, Giro y Remate de Media Distancia', description: 'Recibe un balón desde zona defensiva, gira rápidamente perfilándote y dispara al arco antes del cierre.', duration: '20 mins' }
          ];
        } else {
          // FWD
          playstyleBadge = sr > 1200 ? 'Depredador del Área' : 'Goleador Clínico';
          tacticalSummary += ' Muestras un olfato goleador sobresaliente y buena movilidad para desmarcarte en el último tercio del campo. Para maximizar tu SR, enfócate en la efectividad de definición mano a mano con el portero y en presionar la salida rival.';
          strengths = ['Desmarques explosivos en diagonal', 'Agilidad mental para definir de primera intención'];
          weaknesses = ['Presión alta coordinada a los defensores rivales', 'Fuerza física para aguantar el balón de espaldas al arco'];
          tips = [
            'Varía tus movimientos de desmarque: haz un amague de venir en apoyo y pica al espacio vacío a espaldas del central.',
            'Cuando estés mano a mano con el arquero, prefiere un remate cruzado y raso al segundo poste; es estadísticamente el más difícil de atajar.'
          ];
          drills = [
            { name: 'Definición Directa y Perfiles', description: 'Recibe centros veloces o pases filtrados y define con un solo toque utilizando ambos perfiles.', duration: '20 mins' },
            { name: 'Amague y Desmarque de Ruptura', description: 'Entrena piques en diagonal coordinando el fuera de juego con la habilitación de un compañero.', duration: '15 mins' }
          ];
        }

        // Add history notes
        if (history.length > 0) {
          const recent = history.slice(0, 3);
          const winsCount = recent.filter(h => h.result === 'win').length;
          const lossesCount = recent.filter(h => h.result === 'loss').length;

          if (winsCount >= 2) {
            tacticalSummary += ' ¡Actualmente te encuentras en una racha sumamente positiva! Tu influencia táctica está siendo fundamental para las victorias de tu equipo.';
            tips.push('Aprovecha este momento dulce de confianza para tomar más responsabilidades ofensivas o de distribución.');
          } else if (lossesCount >= 2) {
            tacticalSummary += ' Estás experimentando una seguidilla de partidos complicados. Simplificar las entregas y mantener el orden táctico te ayudará a recuperar tu nivel óptimo rápidamente.';
            tips.push('En tu siguiente encuentro, prioriza pases seguros de corta distancia (fútbol de control) durante los primeros 10 minutos para entrar en ritmo.');
          }
        }

        return {
          playstyleBadge,
          tacticalSummary,
          strengths,
          weaknesses,
          tips,
          drills
        };
      };

      // Check if Gemini API key exists
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
        // Return structured mock fallback data
        return res.json({
          source: 'local_fallback',
          ...getFallback()
        });
      }

      // Initialize GoogleGenAI client
      const ai = new GoogleGenAI({ apiKey });
      const total = user.matchesPlayed || 0;
      const wins = user.wins || 0;
      const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

      const historyText = history.slice(0, 5).map(h => 
        `- Partido "${h.title}" el ${h.date} (Cancha ${h.pitchType}). Marcador: ${h.scoreA}-${h.scoreB}. Resultado para ti: ${h.result}. Cambio de SR: ${h.srChange}`
      ).join('\n');

      const prompt = `
Eres un Coach de Fútbol Amateur muy cercano, directo y apasionado para la plataforma "Matchmaking Fútbol Amateur".
Analiza minuciosamente el perfil de rendimiento real de este jugador para darle un informe de coaching realista y muy motivacional, hablándole como un entrenador experimentado que ha estado al borde de la cancha viéndolo jugar en sus últimos partidos.

Datos reales del jugador desde la base de datos:
- Nombre del Jugador: ${user.name}
- Posición en la que juega: ${user.preferredPosition}
- Skill Rating (SR) actual: ${user.skillRating}
- Total partidos jugados: ${user.matchesPlayed}
- Victorias: ${user.wins}
- Derrotas: ${user.losses}
- Empates: ${user.draws}
- Tasa de efectividad de victorias: ${winRate}%

Historial de los partidos que disputó recientemente:
${historyText || 'Aún no tiene partidos finalizados registrados en su historial. Anímalo a jugar su primer partido.'}

Instrucciones de Tono y Estilo:
- NO seas aburrido ni uses jerga excesivamente científica/académica de laboratorio deportivo. Habla con palabras sencillas, claras y al grano, como un DT que platica contigo después de un partido picante de fin de semana.
- Refiérete directamente a sus estadísticas reales (como su Skill Rating de ${user.skillRating}, sus partidos, victorias o su posición preferida de ${user.preferredPosition}).
- Haz comentarios que denoten que has "observado" sus últimos partidos (por ejemplo, si tiene victorias, elogia su ritmo de juego; si tiene derrotas recientes o si no tiene partidos aún, dale pautas realistas sobre cómo entrar en ritmo o cómo evitar regalar espacios).
- Tu respuesta debe ser un objeto JSON estrictamente válido que use exactamente la estructura indicada abajo.

El JSON de respuesta debe tener exactamente estos campos en español:
{
  "playstyleBadge": "Apodo o título de vestuario corto y motivador (máximo 4 palabras, ej: 'El Corazón del Equipo', 'Guardián del Arco', 'Killer del Área', 'Cerebro de la Cancha')",
  "tacticalSummary": "Un análisis y feedback realista de su juego y estado actual basado en sus datos reales y lo observado en cancha en sus partidos recientes (entre 3 y 5 oraciones directas, honestas y motivadoras).",
  "strengths": ["Una fortaleza real que demostró en la cancha", "Otra fortaleza o virtud en su juego de equipo"],
  "weaknesses": ["Un punto débil o error común que comete y debe corregir", "Otro detalle táctico a pulir para subir su nivel"],
  "tips": [
    "Un consejo práctico, directo y fácil de aplicar en su próximo partido",
    "Otro consejo de vestuario para mejorar su juego de inmediato"
  ],
  "drills": [
    {
      "name": "Nombre de un Ejercicio Sencillo",
      "description": "Explicación breve de cómo entrenar esto solo o con un amigo de manera fácil",
      "duration": "Tiempo recomendado (ej: 10 mins)"
    },
    {
      "name": "Nombre de otro Ejercicio Sencillo",
      "description": "Explicación breve de cómo entrenar esto solo o con un amigo de manera fácil",
      "duration": "Tiempo recomendado (ej: 15 mins)"
    }
  ]
}
`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        }
      });

      const responseText = response.text;
      if (!responseText) {
        throw new Error('Empty response from Gemini');
      }

      const cleanJson = JSON.parse(responseText.trim());
      return res.json({
        source: 'gemini_api',
        ...cleanJson
      });

    } catch (err: any) {
      console.error('Error in AI Coach endpoint:', err);
      // Fail gracefully and return the fallback so the user always has data
      try {
        const userId = req.user!.id;
        const user = (await db.ensureUserLoaded(userId))!;
        const history = db.getPlayerHistory(userId);
        
        const positionName = {
          GK: 'Portero',
          DEF: 'Defensa',
          MID: 'Mediocampista',
          FWD: 'Delantero',
        }[user.preferredPosition as Position] || 'Futbolista';

        return res.json({
          source: 'local_fallback_error_recovery',
          playstyleBadge: user.skillRating > 1200 ? 'Estratega Líder' : 'Jugador de Equipo',
          tacticalSummary: `Análisis táctico básico para ${user.name}: Con un SR de ${user.skillRating} en la posición de ${positionName}, demuestras potencial. Es importante afianzar los conceptos defensivos de repliegue y mejorar la velocidad de entrega.`,
          strengths: ['Compromiso físico durante el encuentro', 'Actitud de juego colectivo'],
          weaknesses: ['Control orientado rápido en transiciones', 'Disparos de larga distancia'],
          tips: [
            'Mantén tu cabeza levantada antes de recibir el balón para anticipar la marca.',
            'Intenta jugar más pases de primera intención para acelerar el ritmo del juego.'
          ],
          drills: [
            { name: 'Control Orientado y Pase', description: 'Práctica recibir el balón perfilándote con pierna lejana y descargar con pase firme.', duration: '15 minutos' }
          ]
        });
      } catch (innerErr) {
        return res.status(500).json({ error: 'Error interno en el coach táctico' });
      }
    }
  });

  // 14. Get Supabase Status and SQL Setup Script
  app.get('/api/supabase/status', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { checkSupabaseStatus, getSupabaseSQLScript } = await import('./server/supabase');
      const status = await checkSupabaseStatus();
      const sql = getSupabaseSQLScript();
      
      const maskedKey = process.env.SUPABASE_ANON_KEY 
        ? `${process.env.SUPABASE_ANON_KEY.slice(0, 8)}...${process.env.SUPABASE_ANON_KEY.slice(-8)}`
        : 'No configurada';

      return res.json({
        ...status,
        url: process.env.SUPABASE_URL || 'No configurada',
        key: maskedKey,
        sql
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // --- SOCKET.IO EVENT HANDLERS ---
  io.on('connection', (socket) => {
    let currentRoomId: string | null = null;

    socket.on('join_room', ({ roomId }) => {
      if (currentRoomId) {
        socket.leave(`room_${currentRoomId}`);
      }
      currentRoomId = roomId;
      socket.join(`room_${roomId}`);
      console.log(`Socket ${socket.id} joined room_${roomId}`);
    });

    socket.on('leave_room', ({ roomId }) => {
      socket.leave(`room_${roomId}`);
      if (currentRoomId === roomId) {
        currentRoomId = null;
      }
      console.log(`Socket ${socket.id} left room_${roomId}`);
    });

    socket.on('send_message', ({ roomId, userId, userName, text }) => {
      try {
        const message = db.addMessage(roomId, userId, userName, text);
        io.to(`room_${roomId}`).emit('chat_message', message);
      } catch (err) {
        console.error('Error saving socket message:', err);
      }
    });

    socket.on('disconnect', () => {
      console.log(`Socket ${socket.id} disconnected`);
    });
  });

  // --- VITE AND SPA ROUTING MIDDLEWARE ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Start Server on PORT 3000
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
