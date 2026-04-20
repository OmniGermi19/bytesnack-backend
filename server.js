const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Configuración de MySQL
const dbConfig = {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
};

console.log('📡 Conectando a MySQL...');
console.log(`   Host: ${dbConfig.host}:${dbConfig.port}`);
console.log(`   Database: ${dbConfig.database}`);

const db = mysql.createConnection(dbConfig);

db.connect((err) => {
    if (err) {
        console.error('❌ Error conectando a MySQL:', err.message);
        process.exit(1);
    }
    console.log('✅ Conectado a MySQL correctamente');
});

// Importar rutas
const authRoutes = require('./routes/auth')(db);
const productRoutes = require('./routes/products')(db);
const cartRoutes = require('./routes/cart')(db);
const orderRoutes = require('./routes/orders')(db);
const userRoutes = require('./routes/users')(db);
const adminRoutes = require('./routes/admin')(db);

// Usar rutas
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);

// Ruta de salud
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Servidor funcionando correctamente' });
});

app.get('/', (req, res) => {
    res.json({ message: 'ByteSnack API funcionando' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});