const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const paymentController = require('./paymentController');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.send('Tiketons Payment Gateway is Running...');
});

// 1. Android panggil ini untuk minta Kode Bayar
app.post('/api/payment/charge', paymentController.charge);

// 2. Midtrans panggil ini (Otomatis) untuk lapor status bayar
app.post('/api/payment/notification', paymentController.notification);

app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});