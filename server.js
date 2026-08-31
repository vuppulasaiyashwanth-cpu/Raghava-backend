const express = require('express');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'raghava_secret_token_2026';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Root health check
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

// Dispatcher to Meta Graph API
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

// Send Plain Text
async function sendTextMessage(toPhone, messageText) {
  const cleanPhone = toPhone.replace(/\D/g, ''); // Digits only

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
  const cleanPhone = toPhone.replace(/\D/g, ''); // Digits only

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

// Webhook Event Receiver (POST /webhook)
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

        // Handle Interactive Quick-Reply Button Click
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
        // Handle Inbound Text
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
