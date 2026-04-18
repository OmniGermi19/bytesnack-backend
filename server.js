const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Ruta de prueba
app.get('/', (req, res) => {
    res.json({ 
        message: 'ByteSnack API',
        version: '1.0.0',
        status: 'online'
    });
});

// Ruta de prueba para conexión a BD
app.get('/test-db', async (req, res) => {
    const db = require('./config/database');
    try {
        const [result] = await db.query('SELECT 1 as test');
        res.json({ success: true, message: 'BD conectada', result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📍 http://localhost:${PORT}\n`);
});