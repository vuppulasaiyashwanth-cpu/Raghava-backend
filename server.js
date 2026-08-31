const express = require('express');
require('dotenv').config();

const app = express();

// Enable CORS & JSON Parsing
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'raghava_secret_token_2026';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Health Check
app.get('/', (req, res) => {
  res.status(200).send('Raghava Webhook Engine is online.');
});

// Meta Webhook Verification (GET /webhook)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Core WhatsApp API Dispatcher
async function callWhatsAppAPI(payload) {
  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('WhatsApp API Error:', JSON.stringify(data, null, 2));
    }
    return data;
  } catch (err) {
    console.error('WhatsApp Dispatch Error:', err);
  }
}

// 1. Mark Incoming Message As Read (Blue Ticks)
async function markAsRead(messageId) {
  try {
    await callWhatsAppAPI({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    });
  } catch (e) {
    console.error('Mark read error:', e);
  }
}

// 2. Send Plain Text
async function sendTextMessage(toPhone, messageText) {
  const cleanPhone = toPhone.toString().replace(/\D/g, '');
  return await callWhatsAppAPI({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'text',
    text: { body: messageText }
  });
}

// 3. Step 1: Send Zone Selection Buttons
async function sendZoneOptions(toPhone) {
  const cleanPhone = toPhone.toString().replace(/\D/g, '');
  return await callWhatsAppAPI({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: 'Welcome to Raghava Projects. Select a zone to explore our active luxury developments:'
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'btn_east', title: 'East Zone' } },
          { type: 'reply', reply: { id: 'btn_west', title: 'West Zone' } },
          { type: 'reply', reply: { id: 'btn_north', title: 'North Zone' } }
        ]
      }
    }
  });
}

// 4. Step 2: Send Configuration / BHK Selection Buttons
async function sendBhkOptions(toPhone, zoneName) {
  const cleanPhone = toPhone.toString().replace(/\D/g, '');
  return await callWhatsAppAPI({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: `Featured in ${zoneName}:\n• Ultra-luxury specifications\n• Clubhouse & private amenities\n\nWhat unit size fits your requirements?`
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'btn_3bhk', title: '3 BHK' } },
          { type: 'reply', reply: { id: 'btn_4bhk', title: '4 BHK' } },
          { type: 'reply', reply: { id: 'btn_skyvilla', title: 'Sky Villa' } }
        ]
      }
    }
  });
}

// 5. Step 3: Send Final Action Buttons (Visit / Brochure)
async function sendActionOptions(toPhone, unitType) {
  const cleanPhone = toPhone.toString().replace(/\D/g, '');
  return await callWhatsAppAPI({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: `Recorded preference: *${unitType}*.\n\nHow would you like to proceed?`
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'btn_visit', title: 'Book Site Visit' } },
          { type: 'reply', reply: { id: 'btn_brochure', title: 'Get Brochure' } }
        ]
      }
    }
  });
}

// API to Trigger WhatsApp Flow from Dashboard / cURL (POST /api/trigger-lead)
app.post('/api/trigger-lead', async (req, res) => {
  const { name, phone, project } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  const cleanPhone = phone.toString().replace(/\D/g, '');
  console.log(`Lead triggered for ${name || 'Prospect'} (${cleanPhone})`);

  try {
    const welcomeText = `Hello ${name || 'there'}! Thank you for your interest in ${project || 'Raghava Projects'}.`;
    await sendTextMessage(cleanPhone, welcomeText);
    await sendZoneOptions(cleanPhone);

    return res.status(200).json({ success: true, message: `Lead flow initiated for ${cleanPhone}` });
  } catch (error) {
    console.error('Trigger lead error:', error);
    return res.status(500).json({ error: 'Failed to initiate WhatsApp lead message' });
  }
});

// Meta Webhook Message Receiver (POST /webhook)
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0]?.value;

      if (changes?.messages && changes.messages[0]) {
        const msg = changes.messages[0];
        const fromPhone = msg.from;
        const messageType = msg.type;
        const messageId = msg.id;

        // Trigger Blue Ticks
        await markAsRead(messageId);

        console.log(`Inbound event from ${fromPhone} [${messageType}]`);

        // Handle Interactive Button Replies (Multi-Step Funnel)
        if (messageType === 'interactive' && msg.interactive?.type === 'button_reply') {
          const selectedId = msg.interactive.button_reply.id;

          // Step 1 -> Step 2 Transitions
          if (selectedId === 'btn_west') {
            await sendBhkOptions(fromPhone, 'West Hyderabad (Raghava Iris)');
          } else if (selectedId === 'btn_east') {
            await sendBhkOptions(fromPhone, 'East Hyderabad (Raghava Wave)');
          } else if (selectedId === 'btn_north') {
            await sendBhkOptions(fromPhone, 'North Hyderabad (Raghava North Gate)');
          } 
          // Step 2 -> Step 3 Transitions
          else if (selectedId === 'btn_3bhk') {
            await sendActionOptions(fromPhone, '3 BHK Residence');
          } else if (selectedId === 'btn_4bhk') {
            await sendActionOptions(fromPhone, '4 BHK Residence');
          } else if (selectedId === 'btn_skyvilla') {
            await sendActionOptions(fromPhone, 'Ultra Luxury Sky Villa');
          } 
          // Final Confirmations
          else if (selectedId === 'btn_visit') {
            await sendTextMessage(fromPhone, '✅ *Site Visit Confirmed.*\nOur relationship manager will call you within 15 minutes to finalize the timing and gate pass.');
          } else if (selectedId === 'btn_brochure') {
            await sendTextMessage(fromPhone, '📄 *Brochure Requested.*\nThe comprehensive project deck, floor plans, and pricing sheet have been shared with your contact number.');
          }
        } 
        // Handle Plain Text Inquiries
        else if (messageType === 'text') {
          const text = (msg.text.body || '').toLowerCase().trim();

          if (text.includes('hi') || text.includes('hello') || text.includes('hey') || text.includes('start')) {
            await sendZoneOptions(fromPhone);
          } else {
            await sendTextMessage(fromPhone, 'Thank you for reaching out to Raghava Projects. Type *Hi* to explore our project portfolio.');
          }
        }
      }
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
  }
});

app.listen(PORT, () => {
  console.log(`Raghava Webhook Engine running on port ${PORT}`);
});
