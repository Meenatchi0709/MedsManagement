const express = require('express')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const cors = require('cors')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const path = require('path')
const http = require('http')
const { Server } = require('socket.io')

const app = express()
app.use(cors())
app.use(express.json())

const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: '*',
  },
})

app.set('io', io)

io.on('connection', socket => {
  console.log('A client connected')

  socket.on('disconnect', () => {
    console.log('Client disconnected')
  })
})

const dbPath = path.join(__dirname, 'meds.db')
let db = null

const initializeDB = async () => {
  try {
    db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    })

    await db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      role TEXT
    )`)

    await db.run(`CREATE TABLE IF NOT EXISTS medications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER,
      name TEXT,
      dosage TEXT,
      frequency TEXT,
      takenToday INTEGER DEFAULT 0,
      FOREIGN KEY(userId) REFERENCES users(id)
    )`)

    await db.run(`CREATE TABLE IF NOT EXISTS medication_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER,
      date TEXT,
      FOREIGN KEY(userId) REFERENCES users(id)
    )`)

    server.listen(3000, () => {
      console.log('Server running at http://localhost:3000/')
    })
  } catch (error) {
    console.error(`Error initializing DB: ${error.message}`)
    process.exit(1)
  }
}

initializeDB()

// Signup
app.post('/signup', async (req, res) => {
  const { username, password, role } = req.body
  const hashedPassword = await bcrypt.hash(password, 10)

  try {
    await db.run(
      `INSERT INTO users (username, password, role) VALUES (?, ?, ?)`,
      [username, hashedPassword, role]
    )
    res.status(201).json({ message: 'Signup successful' })
  } catch (err) {
    res.status(400).json({ message: err.message })
  }
})

// Login
app.post('/login', async (req, res) => {
  const { username, password } = req.body

  try {
    const user = await db.get(`SELECT * FROM users WHERE username = ?`, [username])
    if (!user) return res.status(401).send({ message: 'Invalid credentials' })

    const isMatch = await bcrypt.compare(password, user.password)
    if (!isMatch) return res.status(401).send({ message: 'Invalid credentials' })

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      'my_secret_key',
      { expiresIn: '15d' }
    )

    res.send({ token, message: 'Login successful' })
  } catch (err) {
    res.status(500).send({ message: 'Server error' })
  }
})

// Add Medication
app.post('/medications', async (req, res) => {
  const { name, dosage, frequency } = req.body
  const token = req.headers.authorization?.split(' ')[1]

  try {
    const { userId } = jwt.verify(token, 'my_secret_key')
    await db.run(
      `INSERT INTO medications (userId, name, dosage, frequency) VALUES (?, ?, ?, ?)`,
      [userId, name, dosage, frequency]
    )
    res.status(201).send({ message: 'Medication added' })
  } catch (err) {
    res.status(401).send({ message: 'Unauthorized or failed to add' })
  }
})

// Get Medications
app.get('/medications', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1]

  try {
    const { userId } = jwt.verify(token, 'my_secret_key')
    const meds = await db.all(`SELECT * FROM medications WHERE userId = ?`, [userId])
    res.send(meds)
  } catch (err) {
    res.status(401).send({ message: 'Unauthorized' })
  }
})

// put
app.put('/medications/:id/taken', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1]
  const { id } = req.params
  const today = new Date().toISOString().split('T')[0]

  try {
    const { userId } = jwt.verify(token, 'my_secret_key')

    const alreadyMarked = await db.get(
      `SELECT * FROM medication_logs WHERE userId = ? AND date = ?`,
      [userId, today]
    )

    if (!alreadyMarked) {
      await db.run(
        `INSERT INTO medication_logs (userId, date) VALUES (?, ?)`,
        [userId, today]
      )

      const io = req.app.get('io')
     io.emit("medicationUpdate", { id, taken: true });
    }

    res.send({ message: 'Marked as taken for today' })
  } catch (err) {
    res.status(401).send({ message: 'Unauthorized or error' })
  }
})

// Adherence API
app.get('/adherence', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]
    const { userId } = jwt.verify(token, 'my_secret_key')

    const totalDays = 30
    const logs = await db.all(
      `SELECT DISTINCT date FROM medication_logs WHERE userId = ?`,
      [userId]
    )

    const takenDays = logs.length
    const percentage = Math.round((takenDays / totalDays) * 100)

    res.send({ adherence: percentage })
  } catch (err) {
    res.status(401).send({ message: 'Unauthorized or error' })
  }
})
