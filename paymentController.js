const midtransClient = require('midtrans-client');
require('dotenv').config();

// Inisialisasi Core API (Lebih fleksibel untuk custom UI di Android)
let core = new midtransClient.CoreApi({
    isProduction: false,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

exports.charge = async (req, res) => {
    try {
        const { orderId, amount, paymentType, customerName, customerEmail } = req.body;

        // Validasi input
        if (!orderId || !amount || !paymentType) {
            return res.status(400).json({
                status: false,
                message: "Data tidak lengkap (orderId, amount, paymentType wajib)"
            });
        }

        // Setup Parameter Midtrans
        let parameter = {
            "payment_type": paymentType === 'alfamart' ? 'cstore' : 'bank_transfer',
            "transaction_details": {
                "gross_amount": parseInt(amount),
                "order_id": orderId,
            },
            "customer_details": {
                "first_name": customerName,
                "email": customerEmail
            }
        };

        // Logic Bank Transfer (BCA, BNI, BRI)
        if (['bca', 'bni', 'bri'].includes(paymentType)) {
            parameter.payment_type = "bank_transfer";
            parameter.bank_transfer = {
                "bank": paymentType
            };
        } 
        
        // Logic Alfamart
        if (paymentType === 'alfamart') {
            parameter.payment_type = "cstore";
            parameter.cstore = {
                "store": "alfamart",
                "message": "Tiketons Payment"
            };
        }

        // Hit Midtrans API
        const chargeResponse = await core.charge(parameter);

        // Parsing Response untuk Android
        let vaNumber = null;
        let qrUrl = null;

        // Ambil VA Number dari response Midtrans
        if (chargeResponse.va_numbers) {
            vaNumber = chargeResponse.va_numbers[0].va_number;
        } else if (chargeResponse.permata_va_number) {
            vaNumber = chargeResponse.permata_va_number;
        } else if (paymentType === 'alfamart') {
             // Kode pembayaran alfamart biasanya di payment_code
             vaNumber = chargeResponse.payment_code;
        }

        // Kirim Response Balik ke Android
        return res.json({
            status: true,
            message: "Transaksi Berhasil Dibuat",
            payment_type: paymentType,
            va_number: vaNumber,
            qr_url: qrUrl,
            total_amount: amount,
            order_id: orderId
        });

    } catch (error) {
        console.error("Midtrans Error:", error.message);
        return res.status(500).json({
            status: false,
            message: "Gagal memproses pembayaran: " + error.message,
            total_amount: 0,
            order_id: "",
            payment_type: ""
        });
    }
};