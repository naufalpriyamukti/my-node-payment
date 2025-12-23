const midtransClient = require('midtrans-client');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// --- INIT ---
console.log("--- [INIT] SERVER STARTING ---");
console.log("Midtrans Key:", process.env.MIDTRANS_SERVER_KEY ? "LOADED" : "MISSING");
console.log("Supabase URL:", process.env.SUPABASE_URL ? "LOADED" : "MISSING");

let core = new midtransClient.CoreApi({
    isProduction: false, // SANDBOX
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// --- 1. CHARGE (Buat Transaksi) ---
exports.charge = async (req, res) => {
    try {
        const { amount, paymentType, customerName, customerEmail, userId, eventId, tribunName } = req.body;

        // GENERATE ORDER ID (Server Side) - Pasti Pendek & Unik
        const randomSuff = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        const timeSec = new Date().getSeconds().toString();
        const serverOrderId = `${timeSec}${randomSuff}`; 

        console.log(`\n--- [REQ] NEW CHARGE: ${serverOrderId} ---`);

        if (!amount || !paymentType) {
            return res.status(400).json({ status: false, message: "Data amount/paymentType tidak lengkap" });
        }

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
            parameter.bank_transfer = { "bank": paymentType };
        } else if (paymentType === 'alfamart') {
            parameter.payment_type = "cstore";
            parameter.cstore = { "store": "alfamart", "message": "Tiketons Payment" };
        }

        // Request ke Midtrans
        const chargeResponse = await core.charge(parameter);
        console.log("[MIDTRANS] Charge Response Code:", chargeResponse.status_code);

        // Ambil VA / Payment Code
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

        // Simpan ke DB
        const { error: insertError } = await supabase
            .from('transactions')
            .insert({
                order_id: serverOrderId,
                user_id: userId,
                event_id: eventId,
                amount: amount,
                payment_type: bankName,
                va_number: vaNumber,
                status: 'PENDING',
                tribun: tribunName,
                created_at: new Date()
            });

        if (insertError) console.error("[DB ERROR] Insert Failed:", insertError.message);
        else console.log("[DB SUCCESS] Data Saved");

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
        console.error("[CRITICAL ERROR]:", error.message);
        return res.status(500).json({ status: false, message: error.message });
    }
};

// --- 2. NOTIFICATION (Webhook) ---
exports.notification = async (req, res) => {
    try {
        console.log("\n--- [WEBHOOK] NOTIFICATION RECEIVED ---");
        
        const statusResponse = await core.transaction.notification(req.body);
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;

        console.log(`Order: ${orderId} | Status: ${transactionStatus} | Fraud: ${fraudStatus}`);

        // --- LOGIKA STATUS LENGKAP ---
        let finalStatus = 'PENDING';

        if (transactionStatus == 'capture') {
            if (fraudStatus == 'challenge') {
                finalStatus = 'CHALLENGE';
            } else if (fraudStatus == 'accept') {
                finalStatus = 'SUCCESS';
            }
        } else if (transactionStatus == 'settlement') {
            finalStatus = 'SUCCESS'; // Uang masuk (Transfer sukses)
        } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
            finalStatus = 'FAILED'; // Gagal/Batal/Kadaluarsa
        } else if (transactionStatus == 'pending') {
            finalStatus = 'PENDING';
        }

        console.log(`[DB] Updating status to: ${finalStatus}`);

        // Update DB
        const { error } = await supabase
            .from('transactions')
            .update({ status: finalStatus })
            .eq('order_id', orderId);

        if (error) console.error("[DB ERROR] Update Status Failed:", error.message);
        else console.log("[DB SUCCESS] Status Updated!");

        // Jika SUKSES, buat Tiket
        if (finalStatus === 'SUCCESS') {
            await createTicketAutomatic(orderId);
        }

        return res.status(200).send('OK');
    } catch (error) {
        console.error("[WEBHOOK ERROR]:", error.message);
        return res.status(500).send('Error');
    }
};

// Helper: Create Ticket
async function createTicketAutomatic(orderId) {
    try {
        console.log(`[TICKET] Creating ticket for ${orderId}...`);
        
        const { data: trx } = await supabase.from('transactions').select('*').eq('order_id', orderId).single();
        if (!trx) return;

        const { data: event } = await supabase.from('events').select('*').eq('id', trx.event_id).single();

        const { error } = await supabase.from('tickets').insert({
            transaction_id: orderId,
            user_id: trx.user_id,
            event_name: event ? event.name : "Event",
            event_date: event ? event.date : new Date(),
            location: event ? event.location : "-",
            tribun: trx.tribun,
            qr_code: `QR-${orderId}-${Date.now()}`,
            is_used: false
        });
        
        if (!error) console.log(`[TICKET] Created Successfully!`);
        else console.error(`[TICKET ERROR] ${error.message}`);

    } catch (e) {
        console.error("[TICKET EXCEPTION]", e);
    }
}
