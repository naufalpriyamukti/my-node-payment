const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const paymentController = require('./paymentController');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Agar Android bisa akses (Cross-Origin)
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
    res.send('Tiketons Payment Gateway is Running...');
});

// Endpoint Utama yang dipanggil Android
app.post('/api/payment/charge', paymentController.charge);

// Start Server
app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});