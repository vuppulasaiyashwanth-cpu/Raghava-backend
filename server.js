const express = require('express');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'raghava_secret_token_2026';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Root Health Check
app.get('/', (req, res) => {
  res.status(200).send('Raghava Webhook Engine is online.');
});

// Meta Webhook Verification (GET /webhook)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }
  res.sendStatus(400);
});

// Outbound Meta Graph API Dispatcher
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
    } else {
      console.log('Message delivered successfully:', data.messages?.[0]?.id);
    }
    return data;
  } catch (err) {
    console.error('Fetch execution error:', err);
  }
}

// Send Plain Text Message
async function sendTextMessage(toPhone, messageText) {
  const cleanPhone = toPhone.toString().replace(/\D/g, '');

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'text',
    text: { body: messageText }
  };

  return await callWhatsAppAPI(payload);
}

// Send Interactive Quick-Reply Buttons
async function sendProjectZones(toPhone) {
  const cleanPhone = toPhone.toString().replace(/\D/g, '');

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: 'Welcome to Raghava Projects. Select a zone to view ongoing luxury developments:'
      },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: {
              id: 'btn_east',
              title: 'East Zone'
            }
          },
          {
            type: 'reply',
            reply: {
              id: 'btn_west',
              title: 'West Zone'
            }
          },
          {
            type: 'reply',
            reply: {
              id: 'btn_north',
              title: 'North Zone'
            }
          }
        ]
      }
    }
  };

  return await callWhatsAppAPI(payload);
}

// ----------------------------------------------------
// Lead Trigger API (POST /api/trigger-lead)
// ----------------------------------------------------
app.post('/api/trigger-lead', async (req, res) => {
  const { name, phone, project } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  const cleanPhone = phone.toString().replace(/\D/g, '');
  console.log(`Lead triggered for ${name || 'Customer'} (${cleanPhone}) for project: ${project || 'General Inquiry'}`);

  try {
    const welcomeText = `Hello ${name || 'there'}! Thank you for your interest in ${project || 'Raghava Projects'}. Our team has received your inquiry and will connect with you shortly.`;
    
    await sendTextMessage(cleanPhone, welcomeText);
    await sendProjectZones(cleanPhone);

    return res.status(200).json({
      success: true,
      message: `Lead qualification flow initiated for ${cleanPhone}`
    });
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

        console.log(`Incoming message from ${fromPhone} [type: ${messageType}]`);

        // Handle Quick-Reply Button Click
        if (messageType === 'interactive' && msg.interactive?.type === 'button_reply') {
          const selectedButtonId = msg.interactive.button_reply.id;

          if (selectedButtonId === 'btn_east') {
            await sendTextMessage(fromPhone, 'You selected East Zone. Featured project: Raghava Wave. 3 & 4 BHK luxury residences.');
          } else if (selectedButtonId === 'btn_west') {
            await sendTextMessage(fromPhone, 'You selected West Zone. Featured project: Raghava Iris, Financial District. Ultra-luxury sky villas.');
          } else if (selectedButtonId === 'btn_north') {
            await sendTextMessage(fromPhone, 'You selected North Zone. Premium gated community villas coming soon.');
          }
        } 
        // Handle Plain Text Message
        else if (messageType === 'text') {
          const incomingText = (msg.text.body || '').toLowerCase().trim();

          if (incomingText.includes('hi') || incomingText.includes('hello') || incomingText.includes('hey')) {
            await sendProjectZones(fromPhone);
          } else {
            await sendTextMessage(fromPhone, 'Thank you for reaching out to Raghava. Reply "Hi" anytime to explore our project portfolio.');
          }
        }
      }
    }
  } catch (error) {
    console.error('Webhook processing exception:', error);
  }
});

app.listen(PORT, () => {
  console.log(`Raghava Webhook Engine running on port ${PORT}`);
});
