const midtransClient = require('midtrans-client');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// --- INIT ---
console.log("--- [INIT] SERVER STARTING ---");
console.log("Is Production:", false);

let core = new midtransClient.CoreApi({
    isProduction: false,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// --- 1. CHARGE ---
exports.charge = async (req, res) => {
    try {
        // PERBAIKAN: Tambahkan 'eventName' di sini agar terbaca dari Android
        const { amount, paymentType, customerName, customerEmail, userId, eventId, eventName, tribunName } = req.body;

        // 1. GENERATE ID (5-6 DIGIT ANGKA)
        const randomSuff = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        const timeSec = new Date().getSeconds().toString();
        const serverOrderId = `${timeSec}${randomSuff}`; 

        console.log(`\n=============================================`);
        console.log(`[REQ] START TRANSACTION`);
        console.log(`Generated Order ID : ${serverOrderId}`);
        console.log(`Payment Type       : ${paymentType}`);
        console.log(`Amount             : ${amount}`);
        console.log(`Event Name         : ${eventName}`); // Log Event Name
        
        if (!amount || !paymentType) {
            return res.status(400).json({ status: false, message: "Data tidak lengkap" });
        }

        // 2. SETUP PARAMETER
        let parameter = {
            "payment_type": paymentType === 'alfamart' ? 'cstore' : 'bank_transfer',
            "transaction_details": {
                "gross_amount": parseInt(amount),
                "order_id": serverOrderId, 
            },
            "customer_details": {
                "first_name": customerName || "Customer",
                "email": customerEmail || "email@example.com"
            }
        };

        if (['bca', 'bni', 'bri', 'permata'].includes(paymentType)) {
            parameter.payment_type = "bank_transfer";
            parameter.bank_transfer = { 
                "bank": paymentType,
                "va_number": serverOrderId // <--- PAKSA AGAR VA = ORDER ID (Khusus BCA)
            };
        } else if (paymentType === 'alfamart') {
            parameter.payment_type = "cstore";
            parameter.cstore = { "store": "alfamart", "message": "Tiketons" };
        }

        // 3. TEMBAK KE MIDTRANS
        console.log(`[PROCESS] Sending to Midtrans...`);
        const chargeResponse = await core.charge(parameter);

        // --- LOGGING PENTING ---
        console.log(`---------------------------------------------`);
        console.log(`[MIDTRANS RESPONSE]`);
        console.log(`Status Code : ${chargeResponse.status_code}`);
        console.log(`Order ID    : ${chargeResponse.order_id}`);
        
        // Cek VA yang didapat
        let vaNumber = null;
        let bankName = paymentType;

        if (chargeResponse.va_numbers && chargeResponse.va_numbers.length > 0) {
             vaNumber = chargeResponse.va_numbers[0].va_number;
             bankName = chargeResponse.va_numbers[0].bank;
             console.log(`VA Number   : ${vaNumber} (Bank: ${bankName})`);
        } else if (chargeResponse.permata_va_number) {
             vaNumber = chargeResponse.permata_va_number;
             console.log(`VA Permata  : ${vaNumber}`);
        } else if (chargeResponse.payment_code) {
            vaNumber = chargeResponse.payment_code;
            console.log(`Pay Code    : ${vaNumber} (Alfamart)`);
        } else {
            console.log(`VA Number   : TIDAK DITEMUKAN DI RESPONSE!`);
            console.log(`Full JSON   : ${JSON.stringify(chargeResponse)}`);
        }
        console.log(`---------------------------------------------`);

        // 4. SIMPAN KE DB
        const { error: insertError } = await supabase
            .from('transactions')
            .insert({
                order_id: serverOrderId,
                user_id: userId,
                event_id: eventId,
                event_name: eventName || "Event Tiketons", // <--- PERBAIKAN: SIMPAN NAMA EVENT
                amount: amount,
                payment_type: bankName,
                va_number: vaNumber,
                status: 'PENDING',
                tribun: tribunName,
                created_at: new Date()
            });

        if (insertError) console.error("[DB ERROR]", insertError.message);
        else console.log("[DB SUCCESS] Data Saved to Supabase");
        console.log(`=============================================\n`);

        return res.json({
            status: true,
            message: "Transaksi Berhasil",
            data: {
                order_id: chargeResponse.order_id,
                total_amount: chargeResponse.gross_amount,
                payment_type: bankName,
                va_number: vaNumber,
                expiration_time: chargeResponse.expiry_time
            }
        });

    } catch (error) {
        console.error("[CRITICAL ERROR]", error.message);
        // Print detail error dari Midtrans jika ada
        if(error.ApiResponse) {
            console.error("[MIDTRANS ERROR DETAIL]", JSON.stringify(error.ApiResponse, null, 2));
        }
        return res.status(500).json({ status: false, message: error.message });
    }
};

// --- 2. NOTIFICATION ---
exports.notification = async (req, res) => {
    try {
        console.log("\n--- [WEBHOOK] NOTIFICATION RECEIVED ---");
        const statusResponse = await core.transaction.notification(req.body);
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;

        console.log(`Order: ${orderId} | Status: ${transactionStatus}`);

        let finalStatus = 'PENDING';
        if (transactionStatus == 'capture') {
            if (fraudStatus == 'challenge') finalStatus = 'CHALLENGE';
            else if (fraudStatus == 'accept') finalStatus = 'SUCCESS';
        } else if (transactionStatus == 'settlement') {
            finalStatus = 'SUCCESS';
        } else if (['cancel', 'deny', 'expire'].includes(transactionStatus)) {
            finalStatus = 'FAILED';
        }

        const { error } = await supabase
            .from('transactions')
            .update({ status: finalStatus })
            .eq('order_id', orderId);

        if (error) console.error("[DB ERROR]", error.message);
        
        if (finalStatus === 'SUCCESS') {
            await createTicketAutomatic(orderId);
        }

        return res.status(200).send('OK');
    } catch (error) {
        console.error("[WEBHOOK ERROR]", error.message);
        return res.status(500).send('Error');
    }
};

async function createTicketAutomatic(orderId) {
    try {
        console.log(`[TICKET] Processing ticket for Order ID: ${orderId}...`);
        
        // 1. Ambil data Transaksi
        const { data: trx, error: errTrx } = await supabase
            .from('transactions')
            .select('*')
            .eq('order_id', orderId)
            .single();

        if (errTrx || !trx) {
            console.error("[TICKET ERROR] Transaksi tidak ditemukan:", errTrx?.message);
            return;
        }

        // 2. Ambil data Event (Fallback)
        let finalEventName = trx.event_name;
        let finalEventDate = new Date();
        let finalEventLoc = "-";

        if (trx.event_id) {
            const { data: event } = await supabase
                .from('events')
                .select('*')
                .eq('id', trx.event_id)
                .single();
            
            if (event) {
                if (!finalEventName || finalEventName === 'undefined') finalEventName = event.name;
                finalEventDate = event.date;
                finalEventLoc = event.location;
            }
        }

        // 3. Insert Tiket (DENGAN CEK ERROR YANG BENAR)
        const { error: errTiket } = await supabase
            .from('tickets')
            .insert({
                transaction_id: orderId,
                user_id: trx.user_id,
                event_name: finalEventName || "Event Tiketons",
                event_date: finalEventDate,
                location: finalEventLoc,
                tribun: trx.tribun,
                qr_code: `QR-${orderId}-${Date.now()}`,
                is_used: false
            });
        
        // --- PERBAIKAN LOGIKA LOGGING ---
        if (errTiket) {
            console.error("#############################################");
            console.error("[TICKET FAILED] Gagal Simpan ke Database!");
            console.error("Pesan Error Supabase:", errTiket.message); // <--- INI KUNCINYA
            console.error("Detail Error:", errTiket.details);
            console.error("#############################################");
        } else {
            console.log("[TICKET SUCCESS] Tiket BERHASIL masuk tabel tickets!");
        }

    } catch (e) {
        console.error("[TICKET EXCEPTION]", e);
    }
}
