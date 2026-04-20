const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

// Importar rutas
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const cartRoutes = require('./routes/cart');
const orderRoutes = require('./routes/orders');
const salesRoutes = require('./routes/sales');
const userRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');

// Usar rutas
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);

// Ruta de prueba
app.get('/', (req, res) => {
    res.json({ message: 'ByteSnack API', version: '2.0.0', status: 'online' });
});

// Ruta para probar conexión a DB
app.get('/test-db', async (req, res) => {
    try {
        const db = require('./config/database');
        const [result] = await db.query('SELECT 1 as test, NOW() as time, DATABASE() as db_name');
        res.json({ success: true, message: 'Base de datos conectada', result });
    } catch (error) {
        console.error('Error en test-db:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Manejo de errores global
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 ByteSnack API corriendo en puerto ${PORT}`);
    console.log(`📡 Base de datos: ${process.env.DB_NAME} en ${process.env.DB_HOST}:${process.env.DB_PORT}`);
    console.log(`\n📌 Endpoints disponibles:`);
    console.log(`   GET  /`);
    console.log(`   GET  /test-db`);
    console.log(`   POST /api/auth/register`);
    console.log(`   POST /api/auth/login`);
    console.log(`   POST /api/auth/refresh`);
    console.log(`   POST /api/auth/logout`);
    console.log(`   GET  /api/products`);
    console.log(`   POST /api/products`);
    console.log(`   DELETE /api/products/:id`);
    console.log(`   GET  /api/cart`);
    console.log(`   POST /api/cart/add`);
    console.log(`   PUT  /api/cart/:productId`);
    console.log(`   DELETE /api/cart/:productId`);
    console.log(`   DELETE /api/cart/clear`);
    console.log(`   GET  /api/orders`);
    console.log(`   POST /api/orders`);
    console.log(`   PATCH /api/orders/:orderId/status`);
    console.log(`   GET  /api/sales`);
    console.log(`   GET  /api/users`);
    console.log(`   PATCH /api/users/:userId/status`);
    console.log(`   GET  /api/admin/stats\n`);
});