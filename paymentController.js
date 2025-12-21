const midtransClient = require('midtrans-client');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 1. Inisialisasi Midtrans
let core = new midtransClient.CoreApi({
    isProduction: false, // Ganti true jika sudah live
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// 2. Inisialisasi Supabase (Admin Mode)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// --- ENDPOINT 1: REQUEST BAYAR (Android -> Node.js -> Midtrans) ---
exports.charge = async (req, res) => {
    try {
        const { orderId, amount, paymentType, customerName, customerEmail } = req.body;

        // Validasi input
        if (!orderId || !amount || !paymentType) {
            return res.status(400).json({
                status: false,
                message: "Data tidak lengkap"
            });
        }

        // Setup Parameter Midtrans Dasar
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

        // Konfigurasi Spesifik Bank Transfer (BCA, BNI, BRI)
        if (['bca', 'bni', 'bri'].includes(paymentType)) {
            parameter.payment_type = "bank_transfer";
            parameter.bank_transfer = { "bank": paymentType };
        } 
        // Konfigurasi Spesifik Alfamart
        else if (paymentType === 'alfamart') {
            parameter.payment_type = "cstore";
            parameter.cstore = { "store": "alfamart", "message": "Tiketons Payment" };
        }

        // A. Kirim Request ke Midtrans Core API
        const chargeResponse = await core.charge(parameter);

        // B. Ektraksi Nomor VA / Kode Bayar (SOLUSI PERBAIKAN)
        // Kita harus mengambil string kode bayar dari struktur JSON yang rumit
        let vaNumber = null;

        // Cek 1: Jika Bank Transfer (BCA, BNI, BRI)
        if (chargeResponse.payment_type === 'bank_transfer') {
            // Midtrans mengembalikan array 'va_numbers', ambil index pertama
            if (chargeResponse.va_numbers && chargeResponse.va_numbers.length > 0) {
                 vaNumber = chargeResponse.va_numbers[0].va_number;
            } 
            // Khusus Permata (jika nanti dipakai)
            else if (chargeResponse.permata_va_number) {
                 vaNumber = chargeResponse.permata_va_number;
            }
        } 
        // Cek 2: Jika Gerai Retail (Alfamart)
        else if (chargeResponse.payment_type === 'cstore') {
            vaNumber = chargeResponse.payment_code;
        }

        // C. Kirim Response Bersih ke Android
        // Android akan menerima 'va_number' sebagai string tunggal, bukan array lagi.
        return res.json({
            status: true,
            message: "Transaksi Berhasil Dibuat",
            order_id: chargeResponse.order_id,
            total_amount: chargeResponse.gross_amount,
            payment_type: chargeResponse.payment_type,
            va_number: vaNumber, // <-- INI KUNCI PERBAIKANNYA
            qr_url: null 
        });

    } catch (error) {
        console.error("Midtrans Error:", error.message);
        return res.status(500).json({
            status: false,
            message: "Gagal memproses pembayaran: " + error.message
        });
    }
};

// --- ENDPOINT 2: NOTIFIKASI STATUS (Midtrans -> Node.js -> Database) ---
exports.notification = async (req, res) => {
    try {
        const statusResponse = await core.transaction.notification(req.body);
        
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;

        console.log(`Notifikasi diterima: Order ${orderId} statusnya ${transactionStatus}`);

        // Tentukan Status Akhir untuk Database
        let finalStatus = 'PENDING';

        if (transactionStatus == 'capture') {
            if (fraudStatus == 'challenge') finalStatus = 'CHALLENGE';
            else if (fraudStatus == 'accept') finalStatus = 'SUCCESS';
        } else if (transactionStatus == 'settlement') {
            finalStatus = 'SUCCESS';
        } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
            finalStatus = 'FAILED';
        } else if (transactionStatus == 'pending') {
            finalStatus = 'PENDING';
        }

        // 1. UPDATE STATUS DI TABEL TRANSACTIONS
        const { error: updateError } = await supabase
            .from('transactions')
            .update({ status: finalStatus })
            .eq('order_id', orderId);

        if (updateError) {
            console.error("Gagal update DB Transaction:", updateError);
            return res.status(500).send('DB Error');
        }

        // 2. JIKA SUKSES, BUAT TIKET OTOMATIS
        if (finalStatus === 'SUCCESS') {
            await createTicketAutomatic(orderId);
        }

        return res.status(200).send('OK');

    } catch (error) {
        console.error("Notification Error:", error.message);
        return res.status(500).send('Internal Server Error');
    }
};

// Fungsi Helper: Buat Tiket di Tabel 'tickets' otomatis
async function createTicketAutomatic(orderId) {
    // Ambil data transaksi dulu untuk tau user_id dan event_id
    const { data: trx, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('order_id', orderId)
        .single();

    if (error || !trx) return;

    // Cek apakah tiket sudah dibuat agar tidak duplikat
    const { data: existing } = await supabase
        .from('tickets')
        .select('id')
        .eq('transaction_id', orderId)
        .single();

    if (existing) return; // Sudah ada, skip

    // Insert Tiket Baru
    // Ambil Detail Event (Tgl, Lokasi) untuk snapshot tiket
    const { data: event } = await supabase
        .from('events')
        .select('*')
        .eq('id', trx.event_id)
        .single();

    await supabase.from('tickets').insert({
        transaction_id: orderId,
        user_id: trx.user_id,
        event_name: trx.event_name,
        event_date: event?.date,
        location: event?.location,
        tribun: trx.tribun,
        qr_code: `TIKET-${orderId}-${Math.floor(Math.random() * 1000)}` // Generate QR String Simple
    });
    
    console.log(`Tiket berhasil dibuat untuk Order ${orderId}`);
}
