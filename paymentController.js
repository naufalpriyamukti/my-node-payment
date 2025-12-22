const midtransClient = require('midtrans-client');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 1. Inisialisasi Midtrans
let core = new midtransClient.CoreApi({
    isProduction: false, // Ubah ke true jika sudah production
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// 2. Inisialisasi Supabase (Service Role / Admin)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// --- ENDPOINT 1: REQUEST BAYAR (Android -> Node.js -> Midtrans) ---
exports.charge = async (req, res) => {
    try {
        const { orderId, amount, paymentType, customerName, customerEmail } = req.body;

        // Validasi input sederhana
        if (!orderId || !amount || !paymentType) {
            return res.status(400).json({
                status: false,
                message: "Data tidak lengkap (Butuh orderId, amount, paymentType)"
            });
        }

        // Setup Parameter Dasar Midtrans
        let parameter = {
            "payment_type": paymentType === 'alfamart' ? 'cstore' : 'bank_transfer',
            "transaction_details": {
                // Pastikan amount jadi integer agar tidak ditolak Midtrans
                "gross_amount": parseInt(amount),
                "order_id": orderId,
            },
            "customer_details": {
                "first_name": customerName || "Customer",
                "email": customerEmail || "customer@example.com"
            }
        };

        // Konfigurasi Bank Transfer (BCA, BNI, BRI)
        if (['bca', 'bni', 'bri'].includes(paymentType)) {
            parameter.payment_type = "bank_transfer";
            parameter.bank_transfer = { "bank": paymentType };
        } 
        // Konfigurasi Gerai (Alfamart)
        else if (paymentType === 'alfamart') {
            parameter.payment_type = "cstore";
            parameter.cstore = { "store": "alfamart", "message": "Pembayaran Tiket" };
        }

        // --- REQUEST KE MIDTRANS ---
        console.log(`Mengirim request ke Midtrans untuk Order: ${orderId}`);
        const chargeResponse = await core.charge(parameter);
        console.log("Respon Midtrans:", JSON.stringify(chargeResponse)); // Log untuk debugging di Railway

        // --- EKSTRAKSI KODE BAYAR (VA NUMBER) ---
        // Ini bagian paling penting agar di Android tidak Null!
        let vaNumber = null;

        if (chargeResponse.payment_type === 'bank_transfer') {
            // Cek apakah ada array va_numbers (BCA, BNI, BRI)
            if (chargeResponse.va_numbers && chargeResponse.va_numbers.length > 0) {
                 vaNumber = chargeResponse.va_numbers[0].va_number;
            } 
            // Cek khusus Permata (Formatnya beda, bukan array)
            else if (chargeResponse.permata_va_number) {
                 vaNumber = chargeResponse.permata_va_number;
            }
        } 
        else if (chargeResponse.payment_type === 'cstore') {
            // Alfamart/Indomaret pakai payment_code
            vaNumber = chargeResponse.payment_code;
        }

        // --- KIRIM RESPONSE KE ANDROID ---
        return res.json({
            status: true,
            message: "Transaksi Berhasil Dibuat",
            order_id: chargeResponse.order_id,
            // Kirim amount sebagai string agar aman
            total_amount: chargeResponse.gross_amount.toString(),
            payment_type: chargeResponse.payment_type,
            
            // Variabel ini yang ditunggu Android
            va_number: vaNumber, 
            
            qr_url: null // Null dulu karena belum pakai QRIS
        });

    } catch (error) {
        console.error("Midtrans Error:", error.message);
        return res.status(500).json({
            status: false,
            message: "Gagal memproses pembayaran: " + error.message
        });
    }
};

// --- ENDPOINT 2: NOTIFIKASI STATUS (Midtrans -> Node.js) ---
exports.notification = async (req, res) => {
    try {
        const statusResponse = await core.transaction.notification(req.body);
        
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;

        console.log(`Notifikasi Masuk: Order ${orderId} -> ${transactionStatus}`);

        // Tentukan Status untuk Database
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

        // 1. UPDATE STATUS DI SUPABASE
        const { error: updateError } = await supabase
            .from('transactions')
            .update({ status: finalStatus })
            .eq('order_id', orderId);

        if (updateError) {
            console.error("Gagal update DB:", updateError);
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

// Fungsi Helper: Buat Tiket otomatis saat pembayaran sukses
async function createTicketAutomatic(orderId) {
    // Ambil data transaksi
    const { data: trx, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('order_id', orderId)
        .single();

    if (error || !trx) return;

    // Cek duplikasi tiket
    const { data: existing } = await supabase
        .from('tickets')
        .select('id')
        .eq('transaction_id', orderId)
        .single();

    if (existing) return; 

    // Ambil info Event
    const { data: event } = await supabase
        .from('events')
        .select('*')
        .eq('id', trx.event_id)
        .single();

    // Simpan Tiket
    await supabase.from('tickets').insert({
        transaction_id: orderId,
        user_id: trx.user_id,
        event_name: trx.event_name,
        event_date: event?.date,
        location: event?.location,
        tribun: trx.tribun,
        qr_code: `TIKET-${orderId}-${Math.floor(Math.random() * 1000)}`
    });
    
    console.log(`Tiket berhasil dibuat untuk Order ${orderId}`);
}
