const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ DATABASE SETUP ============
const dbPath = path.join(__dirname, 'levelone.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('DB Error:', err);
  else console.log('Connected to SQLite');
});

// Initialize tables
db.serialize(() => {
  // Rooms table
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hourlyRate REAL DEFAULT 450
  )`);

  // Bookings table
  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    roomId TEXT NOT NULL,
    customerName TEXT NOT NULL,
    customerEmail TEXT NOT NULL,
    customerPhone TEXT NOT NULL,
    startTime TEXT NOT NULL,
    endTime TEXT NOT NULL,
    totalHours INTEGER NOT NULL,
    totalAmount REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    createdAt TEXT NOT NULL,
    FOREIGN KEY (roomId) REFERENCES rooms(id)
  )`);

  // Payment proofs table
  db.run(`CREATE TABLE IF NOT EXISTS paymentProofs (
    id TEXT PRIMARY KEY,
    bookingId TEXT NOT NULL UNIQUE,
    screenshotPath TEXT NOT NULL,
    uploadedAt TEXT NOT NULL,
    verifiedAt TEXT,
    verifiedBy TEXT,
    notes TEXT,
    FOREIGN KEY (bookingId) REFERENCES bookings(id)
  )`);

  // Staff users table
  db.run(`CREATE TABLE IF NOT EXISTS staffUsers (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'staff'
  )`);
});

// Insert default rooms if not exist
db.run(`INSERT OR IGNORE INTO rooms (id, name, hourlyRate) VALUES 
  ('room_purple', 'Purple Rain', 450),
  ('room_romance', 'Bad Romance', 450),
  ('room_moonlight', 'Moonlight Blue', 450)
`);

// Insert default admin staff (password: admin123)
const hashedPassword = require('crypto').createHash('sha256').update('admin123').digest('hex');
db.run(`INSERT OR IGNORE INTO staffUsers (id, username, password, role) VALUES 
  ('staff_1', 'admin', ?, 'admin')
`, [hashedPassword]);

// ============ MIDDLEWARE ============
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static('public'));

// Serve admin dashboard
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve booking page from root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// File upload for payment proofs
const upload = multer({ 
  dest: 'uploads/proofs',
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ============ EMAIL SETUP ============
// Configure for GCash/bank proof emails
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'your-email@gmail.com',
    pass: process.env.EMAIL_PASS || 'your-app-password'
  }
});

// ============ UTILITY FUNCTIONS ============
const generateBookingRef = () => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `LO-${date}-${random}`;
};

const generatePaymentId = () => `PAY-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const isTimeSlotAvailable = (roomId, startTime, endTime) => {
  return new Promise((resolve) => {
    db.all(
      `SELECT * FROM bookings WHERE roomId = ? AND status = 'active' AND (
        (datetime(startTime) < datetime(?) AND datetime(endTime) > datetime(?))
      )`,
      [roomId, endTime, startTime],
      (err, rows) => {
        if (err) {
          console.error('Slot check error:', err);
          resolve(false);
        } else {
          resolve(rows.length === 0);
        }
      }
    );
  });
};

// ============ CUSTOMER ROUTES ============

// Get available time slots for a room on a specific date
app.get('/api/available-slots/:roomId', (req, res) => {
  const { roomId } = req.params;
  const { date } = req.query; // format: YYYY-MM-DD

  if (!date) {
    return res.status(400).json({ error: 'Date required' });
  }

  const startOfDay = new Date(`${date}T00:00:00`).toISOString();
  const endOfDay = new Date(`${date}T23:59:59`).toISOString();

  // Get all bookings for this room on this date (both pending AND active)
  db.all(
    `SELECT startTime, endTime FROM bookings 
     WHERE roomId = ? AND status IN ('active', 'pending')
     AND date(startTime) = ?
     ORDER BY startTime`,
    [roomId, date],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      // Generate all possible 1-hour slots
      const slots = [];
      for (let hour = 10; hour < 24; hour++) {
        const slotStart = new Date(`${date}T${hour.toString().padStart(2, '0')}:00:00`);
        const slotEnd = new Date(`${date}T${(hour + 1).toString().padStart(2, '0')}:00:00`);
        
        const isBooked = rows.some(booking => {
          const bStart = new Date(booking.startTime);
          const bEnd = new Date(booking.endTime);
          return slotStart < bEnd && slotEnd > bStart;
        });

        slots.push({
          hour,
          time: `${hour.toString().padStart(2, '0')}:00`,
          available: !isBooked
        });
      }

      res.json({ date, room: roomId, slots });
    }
  );
});

// Get all rooms
app.get('/api/rooms', (req, res) => {
  db.all('SELECT * FROM rooms', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Create booking (generates payment QR reference)
app.post('/api/create-booking', express.json(), (req, res) => {
  const { roomId, customerName, customerEmail, customerPhone, startTime, endTime } = req.body;

  // Validate input
  if (!roomId || !customerName || !customerEmail || !customerPhone || !startTime || !endTime) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const start = new Date(startTime);
  const end = new Date(endTime);
  const totalHours = Math.round((end - start) / (1000 * 60 * 60));

  if (totalHours <= 0 || totalHours > 8) {
    return res.status(400).json({ error: 'Invalid duration (1-8 hours)' });
  }

  const totalAmount = totalHours * 450;
  const bookingId = generateBookingRef();

  // Check availability
  isTimeSlotAvailable(roomId, startTime, endTime).then(available => {
    if (!available) {
      return res.status(409).json({ error: 'Time slot not available' });
    }

    // Create booking with "pending" status
    db.run(
      `INSERT INTO bookings (id, roomId, customerName, customerEmail, customerPhone, startTime, endTime, totalHours, totalAmount, status, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [bookingId, roomId, customerName, customerEmail, customerPhone, startTime, endTime, totalHours, totalAmount, new Date().toISOString()],
      function(err) {
        if (err) {
          return res.status(500).json({ error: 'Failed to create booking' });
        }

        // Generate payment reference
        const paymentId = generatePaymentId();
        const paymentNote = `LEVELONE-${bookingId}`;

        res.json({
          bookingId,
          paymentId,
          paymentNote,
          totalAmount,
          totalHours,
          startTime,
          endTime,
          qrphInstructions: {
            message: 'Scan the QRPH QR code below to pay',
            amount: totalAmount,
            reference: paymentNote,
            paymentMethods: ['GCash', 'Fund Transfer']
          }
        });
      }
    );
  });
});

// Upload payment proof screenshot
app.post('/api/upload-proof/:bookingId', upload.single('screenshot'), (req, res) => {
  const { bookingId } = req.params;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Create uploads/proofs directory if it doesn't exist
  const uploadsDir = path.join(__dirname, 'uploads', 'proofs');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // Check if booking exists
  db.get('SELECT * FROM bookings WHERE id = ?', [bookingId], (err, booking) => {
    if (err || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Rename file
    const fileName = `${bookingId}-${Date.now()}.jpg`;
    const filePath = path.join(uploadsDir, fileName);
    const relativePath = path.join('uploads', 'proofs', fileName);
    
    fs.renameSync(req.file.path, filePath);

    // Save proof record with RELATIVE path
    const proofId = `PROOF-${Date.now()}`;
    db.run(
      `INSERT INTO paymentProofs (id, bookingId, screenshotPath, uploadedAt) VALUES (?, ?, ?, ?)`,
      [proofId, bookingId, relativePath, new Date().toISOString()],
      (err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to save proof' });
        }

        // Send email to staff
        const mailOptions = {
          from: process.env.EMAIL_USER || 'your-email@gmail.com',
          to: process.env.STAFF_EMAIL || 'staff@levelone.ph',
          subject: `Payment Proof - ${bookingId}`,
          html: `
            <h2>Payment Proof Submitted</h2>
            <p><strong>Booking ID:</strong> ${bookingId}</p>
            <p><strong>Customer:</strong> ${booking.customerName}</p>
            <p><strong>Amount:</strong> ₱${booking.totalAmount}</p>
            <p><strong>Duration:</strong> ${booking.totalHours} hour(s)</p>
            <p><strong>Time:</strong> ${new Date(booking.startTime).toLocaleString()} - ${new Date(booking.endTime).toLocaleString()}</p>
            <p><a href="${process.env.ADMIN_URL || 'http://localhost:3000'}/admin/verify/${bookingId}">Verify in Dashboard</a></p>
            <hr>
            <p>Customer Email: ${booking.customerEmail}</p>
            <p>Customer Phone: ${booking.customerPhone}</p>
          `
        };

        transporter.sendMail(mailOptions, (err) => {
          if (err) console.error('Email error:', err);
        });

        res.json({
          success: true,
          message: 'Payment proof uploaded. Staff will verify shortly.',
          proofId
        });
      }
    );
  });
});

// ============ STAFF/ADMIN ROUTES ============

// Staff login
app.post('/api/staff-login', (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = require('crypto').createHash('sha256').update(password).digest('hex');

  db.get(
    'SELECT * FROM staffUsers WHERE username = ? AND password = ?',
    [username, hashedPassword],
    (err, user) => {
      if (err || !user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Simple token (in production, use JWT)
      const token = Buffer.from(`${username}:${Date.now()}`).toString('base64');
      res.json({ token, username, role: user.role });
    }
  );
});

// Get pending bookings for verification
app.get('/api/staff/pending-bookings', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  db.all(
    `SELECT b.*, r.name as roomName, pp.screenshotPath, pp.id as proofId
     FROM bookings b
     LEFT JOIN rooms r ON b.roomId = r.id
     LEFT JOIN paymentProofs pp ON b.id = pp.bookingId
     WHERE b.status = 'pending'
     ORDER BY b.createdAt DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// Get all bookings (calendar view)
app.get('/api/staff/all-bookings', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  db.all(
    `SELECT b.*, r.name as roomName
     FROM bookings b
     LEFT JOIN rooms r ON b.roomId = r.id
     WHERE b.status = 'active'
     ORDER BY b.startTime`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// Verify booking and activate it
app.post('/api/staff/verify-booking/:bookingId', (req, res) => {
  const { bookingId } = req.params;
  const { notes } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  db.run(
    `UPDATE bookings SET status = 'active' WHERE id = ?`,
    [bookingId],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to verify booking' });

      // Update payment proof as verified
      const now = new Date().toISOString();
      const verifier = Buffer.from(token).toString('base64').split(':')[0];
      
      db.run(
        `UPDATE paymentProofs SET verifiedAt = ?, verifiedBy = ?, notes = ? WHERE bookingId = ?`,
        [now, verifier, notes, bookingId],
        (err) => {
          if (err) console.error('Failed to update proof:', err);
        }
      );

      // Send confirmation email to customer
      db.get('SELECT * FROM bookings WHERE id = ?', [bookingId], (err, booking) => {
        if (booking) {
          const mailOptions = {
            from: process.env.EMAIL_USER || 'your-email@gmail.com',
            to: booking.customerEmail,
            subject: `✓ Booking Confirmed - ${bookingId}`,
            html: `
              <h2>Your Booking is Confirmed!</h2>
              <p><strong>Booking ID:</strong> ${bookingId}</p>
              <p><strong>Room:</strong> Will be provided upon arrival</p>
              <p><strong>Time:</strong> ${new Date(booking.startTime).toLocaleString()} - ${new Date(booking.endTime).toLocaleString()}</p>
              <p><strong>Duration:</strong> ${booking.totalHours} hour(s)</p>
              <p><strong>Total Amount Paid:</strong> ₱${booking.totalAmount}</p>
              <hr>
              <p>See you at LevelOne! 🎤</p>
            `
          };
          transporter.sendMail(mailOptions, (err) => {
            if (err) console.error('Confirmation email error:', err);
          });
        }
      });

      res.json({ success: true, message: 'Booking verified and activated' });
    }
  );
});

// Reject booking
app.post('/api/staff/reject-booking/:bookingId', (req, res) => {
  const { bookingId } = req.params;
  const { reason } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  db.run(
    `UPDATE bookings SET status = 'rejected' WHERE id = ?`,
    [bookingId],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to reject booking' });

      // Send rejection email to customer
      db.get('SELECT * FROM bookings WHERE id = ?', [bookingId], (err, booking) => {
        if (booking) {
          const mailOptions = {
            from: process.env.EMAIL_USER || 'your-email@gmail.com',
            to: booking.customerEmail,
            subject: `Booking Status - ${bookingId}`,
            html: `
              <h2>Booking Status Update</h2>
              <p>Unfortunately, we could not verify your payment for booking <strong>${bookingId}</strong>.</p>
              <p><strong>Reason:</strong> ${reason || 'Payment verification failed'}</p>
              <p>Please contact us to reschedule.</p>
            `
          };
          transporter.sendMail(mailOptions, (err) => {
            if (err) console.error('Rejection email error:', err);
          });
        }
      });

      res.json({ success: true, message: 'Booking rejected' });
    }
  );
});

// Get proof screenshot
app.get('/api/staff/proof/:bookingId', (req, res) => {
  const { bookingId } = req.params;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  db.get(
    'SELECT screenshotPath FROM paymentProofs WHERE bookingId = ?',
    [bookingId],
    (err, row) => {
      if (err || !row) {
        return res.status(404).json({ error: 'Proof not found' });
      }
      
      // Construct full file path
      const filePath = path.join(__dirname, row.screenshotPath);
      
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Proof file not found' });
      }
      
      res.sendFile(filePath);
    }
  );
});

// ============ SERVER START ============
app.listen(PORT, () => {
  console.log(`🎤 LevelOne KTV Booking Server running on port ${PORT}`);
  console.log(`📊 Admin Dashboard: http://localhost:${PORT}/admin`);
});
