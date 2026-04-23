const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

db.getConnection((err, connection) => {
    if (err) {
        console.error('Error de conexion a MySQL:', err.message);
        process.exit(1);
    }
    console.log('Conectado a MySQL correctamente');
    connection.release();
});

app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    res.status(500).json({ message: 'Error interno del servidor' });
});

app.use('/api/auth', require('./routes/auth')(db));
app.use('/api/products', require('./routes/products')(db));
app.use('/api/cart', require('./routes/cart')(db));
app.use('/api/orders', require('./routes/orders')(db));
app.use('/api/users', require('./routes/users')(db));
app.use('/api/admin', require('./routes/admin')(db));
app.use('/api/sales', require('./routes/sales')(db));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('*', (req, res) => {
    res.status(404).json({ message: `Ruta ${req.originalUrl} no encontrada` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});