const midtransClient = require('midtrans-client');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 1. Inisialisasi Midtrans
let core = new midtransClient.CoreApi({
    isProduction: false,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// 2. Inisialisasi Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// --- ENDPOINT 1: REQUEST BAYAR (Android -> Node.js -> Midtrans) ---
exports.charge = async (req, res) => {
    try {
        // Terima data dari Android. Pastikan userId juga dikirim untuk database
        const { orderId, amount, paymentType, customerName, customerEmail, userId, eventId, tribunName } = req.body;

        // Validasi
        if (!orderId || !amount || !paymentType) {
            return res.status(400).json({ status: false, message: "Data tidak lengkap" });
        }

        // Setup Parameter Midtrans
        let parameter = {
            "payment_type": paymentType === 'alfamart' ? 'cstore' : 'bank_transfer',
            "transaction_details": {
                "gross_amount": parseInt(amount),
                "order_id": orderId,
            },
            "customer_details": {
                "first_name": customerName || "Customer",
                "email": customerEmail || "email@example.com"
            }
        };

        // Set Bank / Store
        if (['bca', 'bni', 'bri', 'permata'].includes(paymentType)) {
            parameter.payment_type = "bank_transfer";
            parameter.bank_transfer = { "bank": paymentType };
        } else if (paymentType === 'alfamart') {
            parameter.payment_type = "cstore";
            parameter.cstore = { "store": "alfamart", "message": "Tiketons Payment" };
        }

        // 1. Request ke Midtrans
        console.log(`[Server] Charge Order: ${orderId} via ${paymentType}`);
        const chargeResponse = await core.charge(parameter);

        // 2. Ekstraksi VA Number / Kode Bayar
        let vaNumber = null;
        let bankName = paymentType;

        if (chargeResponse.va_numbers && chargeResponse.va_numbers.length > 0) {
             vaNumber = chargeResponse.va_numbers[0].va_number;
             bankName = chargeResponse.va_numbers[0].bank;
        } else if (chargeResponse.permata_va_number) {
             vaNumber = chargeResponse.permata_va_number;
        } else if (chargeResponse.payment_code) {
            vaNumber = chargeResponse.payment_code; // Untuk Alfamart/Indomaret
        }

        // 3. SIMPAN KE DATABASE (PENTING: INI YANG KURANG SEBELUMNYA)
        // Kita simpan status 'PENDING' dan va_number yang didapat
        const { error: insertError } = await supabase
            .from('transactions')
            .insert({
                order_id: orderId,
                user_id: userId, // Pastikan dikirim dari Android
                event_id: eventId, // Pastikan dikirim dari Android
                amount: amount,
                payment_type: bankName,
                va_number: vaNumber,
                status: 'PENDING',
                tribun: tribunName, // Jika ada info kursi
                created_at: new Date()
            });

        if (insertError) {
            console.error("Gagal simpan ke DB:", insertError);
            // Tetap lanjut return response ke user, tapi catat error log
        }

        // 4. Kirim Response ke Android
        return res.json({
            status: true,
            message: "Transaksi Berhasil Dibuat",
            data: {
                order_id: chargeResponse.order_id,
                total_amount: chargeResponse.gross_amount,
                payment_type: bankName,
                va_number: vaNumber, // Android langsung dapat nomornya disini!
                expiration_time: chargeResponse.expiry_time // Opsional
            }
        });

    } catch (error) {
        console.error("Midtrans Error:", error.message);
        return res.status(500).json({ status: false, message: error.message });
    }
};

// --- ENDPOINT 2: NOTIFIKASI STATUS (Webook Midtrans) ---
exports.notification = async (req, res) => {
    try {
        const statusResponse = await core.transaction.notification(req.body);
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;

        console.log(`Notifikasi: ${orderId} status ${transactionStatus}`);

        let finalStatus = 'PENDING';
        if (transactionStatus == 'capture' || transactionStatus == 'settlement') {
            if (fraudStatus == 'challenge') finalStatus = 'CHALLENGE';
            else finalStatus = 'SUCCESS';
        } else if (['cancel', 'deny', 'expire'].includes(transactionStatus)) {
            finalStatus = 'FAILED';
        }

        // Update Database Supabase
        const { error } = await supabase
            .from('transactions') // Pastikan nama tabel benar
            .update({ status: finalStatus })
            .eq('order_id', orderId);

        if (error) console.error("DB Update Error:", error);

        // Jika Sukses, Buat Tiket
        if (finalStatus === 'SUCCESS') {
            await createTicketAutomatic(orderId);
        }

        return res.status(200).send('OK');
    } catch (error) {
        console.error("Notification Error:", error);
        return res.status(500).send('Error');
    }
};

// Fungsi helper createTicketAutomatic (sama seperti sebelumnya, pastikan tabelnya ada)
async function createTicketAutomatic(orderId) {
    // Logika buat tiket... (Kode kamu sebelumnya sudah oke disini)
     console.log(`Tiket dibuat untuk ${orderId}`);
}
