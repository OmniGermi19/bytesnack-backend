const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

// Ruta principal
app.get('/', (req, res) => {
    res.json({ 
        message: 'ByteSnack API',
        version: '1.0.0',
        status: 'online',
        database: process.env.DATABASE_URL ? '✅ Conectado a BD' : '⚠️ Sin BD'
    });
});

// Ruta para probar conexión a BD
app.get('/test-db', async (req, res) => {
    try {
        const db = require('./config/database');
        const [result] = await db.query('SELECT 1 as test, NOW() as time, DATABASE() as db_name');
        res.json({ 
            success: true, 
            message: 'Base de datos conectada',
            result 
        });
    } catch (error) {
        console.error('Error en test-db:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Ruta de login (temporal para pruebas)
app.post('/api/auth/login', async (req, res) => {
    const { numeroControl, password, role } = req.body;
    
    try {
        const db = require('./config/database');
        const [users] = await db.query(
            'SELECT * FROM users WHERE numero_control = ? AND is_active = 1',
            [numeroControl]
        );
        
        if (users.length > 0) {
            const user = users[0];
            // Por ahora, comparación simple (después usar bcrypt)
            if (password === '123456') {
                return res.json({
                    success: true,
                    token: 'test-token-' + Date.now(),
                    user: {
                        id: user.id,
                        role: user.role,
                        numeroControl: user.numero_control,
                        nombreCompleto: user.nombre_completo
                    }
                });
            }
        }
        
        res.status(401).json({ 
            success: false, 
            message: 'Credenciales incorrectas' 
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error en el servidor' 
        });
    }
});

// Ruta de productos
app.get('/api/products', async (req, res) => {
    try {
        const db = require('./config/database');
        const [products] = await db.query(
            `SELECT p.*, u.nombre_completo as seller_name 
             FROM products p
             JOIN users u ON p.seller_id = u.id
             WHERE p.is_available = 1
             LIMIT 20`
        );
        res.json({ products });
    } catch (error) {
        console.error('Products error:', error);
        res.json({ products: [] });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📡 DATABASE_URL: ${process.env.DATABASE_URL ? '✅ Configurada' : '❌ No configurada'}\n`);
});