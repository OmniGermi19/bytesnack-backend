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
        status: 'online'
    });
});

// Ruta para probar conexión a BD
app.get('/test-db', async (req, res) => {
    try {
        const db = require('./config/database');
        const [result] = await db.query('SELECT 1 as test, NOW() as time');
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

// Ruta de login (temporal para probar)
app.post('/api/auth/login', async (req, res) => {
    const { numeroControl, password, role } = req.body;
    
    // Respuesta temporal para pruebas
    if (numeroControl === '20241234' && password === '123456') {
        return res.json({
            success: true,
            token: 'test-token-123',
            user: {
                id: 1,
                role: role || 'Comprador',
                numeroControl,
                nombreCompleto: 'Usuario Test'
            }
        });
    }
    
    res.status(401).json({ 
        success: false, 
        message: 'Credenciales incorrectas' 
    });
});

// Ruta de productos
app.get('/api/products', async (req, res) => {
    res.json({
        products: [
            {
                id: 1,
                name: 'Papas Sabritas',
                price: 15,
                description: 'Papas fritas sabor limón',
                stock: 50,
                category: 'Botanas',
                images: [],
                isAvailable: true,
                sellerName: 'Vendedor Test'
            },
            {
                id: 2,
                name: 'Coca-Cola',
                price: 18,
                description: 'Refresco de cola 600ml',
                stock: 30,
                category: 'Bebidas',
                images: [],
                isAvailable: true,
                sellerName: 'Vendedor Test'
            }
        ]
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});