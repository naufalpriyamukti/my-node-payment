const midtransClient = require('midtrans-client');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// --- 0. DEBUGGING AWAL (Cek apakah env terbaca) ---
console.log("--- [INIT] SERVER STARTING ---");
console.log("Is Production Mode:", false); 
console.log("Midtrans Server Key Loaded:", process.env.MIDTRANS_SERVER_KEY ? "YES (****" + process.env.MIDTRANS_SERVER_KEY.slice(-4) + ")" : "NO (UNDEFINED)");
console.log("Supabase URL Loaded:", process.env.SUPABASE_URL ? "YES" : "NO");
console.log("Supabase Key Loaded:", process.env.SUPABASE_SERVICE_KEY ? "YES (****" + process.env.SUPABASE_SERVICE_KEY.slice(-4) + ")" : "NO");

// 1. Inisialisasi Midtrans
let core = new midtransClient.CoreApi({
    isProduction: false, // SANDBOX
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// 2. Inisialisasi Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// --- ENDPOINT 1: REQUEST BAYAR ---
exports.charge = async (req, res) => {
    try {
        // PERUBAHAN 1: Hapus 'orderId' dari req.body (Kita tidak percaya Android)
        const { amount, paymentType, customerName, customerEmail, userId, eventId, tribunName } = req.body;

        // PERUBAHAN 2: GENERATE ID DI SINI (Server Side Generation)
        // Logika: Ambil detik saat ini + 3 angka acak.
        // Hasil: Pasti Angka, Pasti Pendek (5-6 Digit), Pasti Unik.
        const randomSuff = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        const timeSec = new Date().getSeconds().toString();
        const serverOrderId = `${timeSec}${randomSuff}`; 

        // DEBUG: Cek data
        console.log(`\n--- [REQ] CHARGE REQUEST ---`);
        console.log(`[SERVER] Generated NEW OrderID: ${serverOrderId} (Short & Numeric)`);
        console.log(`Amount: ${amount}, Type: ${paymentType}`);
        console.log(`User: ${customerName} (${userId})`);

        // Validasi (Hapus validasi orderId)
        if (!amount || !paymentType) {
            console.error("[ERROR] Data tidak lengkap!");
            return res.status(400).json({ status: false, message: "Data amount/paymentType tidak lengkap" });
        }

        // Setup Parameter
        let parameter = {
            "payment_type": paymentType === 'alfamart' ? 'cstore' : 'bank_transfer',
            "transaction_details": {
                "gross_amount": parseInt(amount),
                "order_id": serverOrderId, // <--- PAKAI ID DARI SERVER
            },
            "customer_details": {
                "first_name": customerName || "Customer",
                "email": customerEmail || "email@example.com"
            }
        };

        if (['bca', 'bni', 'bri', 'permata'].includes(paymentType)) {
            parameter.payment_type = "bank_transfer";
            parameter.bank_transfer = { "bank": paymentType };
        } else if (paymentType === 'alfamart') {
            parameter.payment_type = "cstore";
            parameter.cstore = { "store": "alfamart", "message": "Tiketons Payment" };
        }

        // 1. Request ke Midtrans
        console.log(`[PROCESS] Menghubungi Midtrans dengan ID: ${serverOrderId}...`);
        
        let chargeResponse;
        try {
            chargeResponse = await core.charge(parameter);
            console.log("[DEBUG] Midtrans Response RAW:", JSON.stringify(chargeResponse, null, 2));
        } catch (midError) {
            console.error("[ERROR] Midtrans Request Failed:", midError.message);
            return res.status(500).json({ status: false, message: "Midtrans Error: " + midError.message });
        }

        // 2. Ekstraksi VA
        let vaNumber = null;
        let bankName = paymentType;

        if (chargeResponse.va_numbers && chargeResponse.va_numbers.length > 0) {
             vaNumber = chargeResponse.va_numbers[0].va_number;
             bankName = chargeResponse.va_numbers[0].bank;
        } else if (chargeResponse.permata_va_number) {
             vaNumber = chargeResponse.permata_va_number;
        } else if (chargeResponse.payment_code) {
            vaNumber = chargeResponse.payment_code;
        }

        console.log(`[INFO] VA Number didapat: ${vaNumber}`);

        // 3. Simpan ke Database (PAKAI serverOrderId)
        const { error: insertError } = await supabase
            .from('transactions')
            .insert({
                order_id: serverOrderId, // <--- UPDATE INI JUGA
                user_id: userId,
                event_id: eventId,
                amount: amount,
                payment_type: bankName,
                va_number: vaNumber,
                status: 'PENDING',
                tribun: tribunName,
                created_at: new Date()
            });

        if (insertError) {
            console.error("--- [ERROR] GAGAL SIMPAN DB ---");
            console.error(insertError);
        } else {
            console.log("[SUCCESS] Data tersimpan di Database Supabase");
        }

        return res.json({
            status: true,
            message: "Transaksi Berhasil Dibuat",
            data: {
                order_id: chargeResponse.order_id,
                total_amount: chargeResponse.gross_amount,
                payment_type: bankName,
                va_number: vaNumber,
                expiration_time: chargeResponse.expiry_time
            }
        });

    } catch (error) {
        console.error("[CRITICAL ERROR]:", error);
        return res.status(500).json({ status: false, message: error.message });
    }
};

// --- ENDPOINT 2: NOTIFIKASI (TIDAK ADA PERUBAHAN) ---
exports.notification = async (req, res) => {
    try {
        console.log("\n--- [WEBHOOK] NOTIFIKASI MASUK ---");
        
        const statusResponse = await core.transaction.notification(req.body);
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;

        console.log(`Order: ${orderId} | Status: ${transactionStatus} | Fraud: ${fraudStatus}`);

        let finalStatus = 'PENDING';
        if (transactionStatus == 'capture' || transactionStatus == 'settlement') {
            if (fraudStatus == 'challenge') finalStatus = 'CHALLENGE';
            else finalStatus = 'SUCCESS';
        } else if (['cancel', 'deny', 'expire'].includes(transactionStatus)) {
            finalStatus = 'FAILED';
        }

        console.log(`Status update ke DB menjadi: ${finalStatus}`);

        const { error } = await supabase
            .from('transactions')
            .update({ status: finalStatus })
            .eq('order_id', orderId);

        if (error) {
             console.error("[ERROR] Gagal Update Status DB:", error.message);
        } else {
             console.log("[SUCCESS] Status DB Updated!");
        }

        if (finalStatus === 'SUCCESS') {
            await createTicketAutomatic(orderId);
        }

        return res.status(200).send('OK');
    } catch (error) {
        console.error("[ERROR] Notification Webhook:", error.message);
        return res.status(500).send('Error');
    }
};

async function createTicketAutomatic(orderId) {
    try {
        console.log(`[TICKET] Membuat tiket untuk ${orderId}...`);
        
        const { data: trx, error: errTrx } = await supabase
            .from('transactions')
            .select('*')
            .eq('order_id', orderId)
            .single();

        if (errTrx || !trx) {
            console.error("[ERROR] Transaksi tidak ditemukan saat buat tiket:", errTrx?.message);
            return;
        }

        const { data: event } = await supabase
            .from('events')
            .select('*')
            .eq('id', trx.event_id)
            .single();

        const { error: errTiket } = await supabase
            .from('tickets')
            .insert({
                transaction_id: orderId,
                user_id: trx.user_id,
                event_name: event ? event.name : "Event Tiketons",
                event_date: event ? event.date : new Date(),
                location: event ? event.location : "-",
                tribun: trx.tribun,
                qr_code: `QR-${orderId}-${Date.now()}`,
                is_used: false
            });
        
        if (!errTiket) console.log(`[SUCCESS] Tiket BERHASIL dibuat!`);
        else console.error(`[ERROR] Gagal insert tiket: ${errTiket.message}`);

    } catch (e) {
        console.error("[ERROR] createTicketAutomatic Exception:", e);
    }
}
