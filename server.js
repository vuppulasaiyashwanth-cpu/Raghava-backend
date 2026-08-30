require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Enable CORS for Vercel Frontend
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  next();
});

const PORT = process.env.PORT || 3000;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "YOUR_META_ACCESS_TOKEN";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "YOUR_PHONE_NUMBER_ID";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "raghava_secret_token_2026";

// --- CLIENT ASSET REPOSITORY ---
const PROJECT_ASSETS = {
  brochure: {
    url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    filename: "Raghava_Iris_Digital_Brochure.pdf",
    caption: "Here is the official master brochure for Raghava Projects."
  },
  floorPlan: {
    url: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80",
    caption: "Here is the architectural layout and floor plan."
  },
  paymentPlan: {
    url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    filename: "Construction_Linked_Payment_Plan.pdf",
    caption: "Here is the construction-linked milestone payment schedule."
  },
  videoTour: "https://youtu.be/sample-raghava-iris-tour"
};

// --- AGENT ROTATION POOL (2 Initial Agents, Expandable to 4) ---
const SALES_AGENTS = [
  { id: 'rahul', name: "Rahul", phone: "9100087967", role: "admin", active: true },
  { id: 'raghava', name: "Raghava Reddy", phone: "9100123903", role: "agent", active: true }
];
let currentAgentIndex = 0;

function getNextAgent() {
  const activePool = SALES_AGENTS.filter(a => a.active);
  const agent = activePool[currentAgentIndex % activePool.length];
  currentAgentIndex = (currentAgentIndex + 1) % activePool.length;
  return agent;
}

// --- CENTRAL LIVE LEADS STORE ---
const qualifiedLeads = [];
const userSessions = new Map();

// --- DYNAMIC DELAY ENGINE (2s for every 3 words) ---
function getDynamicDelay(text) {
  if (!text) return 2000;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const delaySec = Math.max(2, Math.ceil(wordCount / 3) * 2); 
  return delaySec * 1000;
}

// --- LEAD QUALIFICATION ENGINE ---
// Hot = All 4 questions answered
// Warm = 2 or more questions answered
// Cold = 0 or 1 question answered
function calculateTier(answersCount) {
  if (answersCount >= 4) return "Hot";
  if (answersCount >= 2) return "Warm";
  return "Cold";
}

function saveOrUpdateLead(phone, session) {
  const tier = calculateTier(session.answersCount || 0);
  const existingIndex = qualifiedLeads.findIndex(l => l.phone === phone);
  
  const leadData = {
    id: phone,
    name: session.name,
    phone: phone,
    project: session.project,
    tier: tier,
    facing: session.data.facing || "Not specified",
    size: session.data.size || "Not specified",
    budget: session.data.budget || "Not specified",
    siteVisit: session.data.siteVisit || "Pending",
    agent: session.assignedAgentId || "rahul",
    assignedAgentName: session.assignedAgentName || "Rahul",
    status: tier === "Hot" ? "Site Visit Booked" : tier === "Warm" ? "Mid-Flow Dropoff" : "New Lead",
    answersCount: session.answersCount || 0,
    timestamp: new Date().toISOString()
  };

  if (existingIndex > -1) {
    qualifiedLeads[existingIndex] = leadData;
  } else {
    qualifiedLeads.unshift(leadData);
  }
}

// --- WHATSAPP CLOUD API HELPERS ---
async function sendWhatsAppRequest(payload) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('WhatsApp API Error:', err.response ? err.response.data : err.message);
  }
}

// 1. Mark as Read (Blue Ticks)
async function markMessageAsRead(messageId) {
  if (!messageId) return;
  return sendWhatsAppRequest({
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId
  });
}

// 2. Send Plain Text
async function sendTextMessage(to, text, delayMs = 1500) {
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  return sendWhatsAppRequest({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body: text }
  });
}

// 3. Send PDF Document
async function sendDocumentMessage(to, fileUrl, filename, caption = "", delayMs = 0) {
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  return sendWhatsAppRequest({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "document",
    document: {
      link: fileUrl,
      filename: filename,
      caption: caption
    }
  });
}

// 4. Send Image (Floor Plans)
async function sendImageMessage(to, imageUrl, caption = "", delayMs = 0) {
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  return sendWhatsAppRequest({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "image",
    image: {
      link: imageUrl,
      caption: caption
    }
  });
}

// 5. Send Interactive Buttons
async function sendButtonMessage(to, bodyText, buttons, delayMs = 1500) {
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  return sendWhatsAppRequest({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: { buttons: buttons.map(b => ({ type: "reply", reply: { id: b.id, title: b.title } })) }
    }
  });
}

// 6. Send Interactive List
async function sendListMessage(to, bodyText, buttonLabel, sections, delayMs = 1500) {
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  return sendWhatsAppRequest({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: { button: buttonLabel, sections: sections }
    }
  });
}

// --- OFF-FLOW / ASSET DISPATCHER (10-Second Delayed Delivery) ---
async function handleAssetAndFaqQueries(phone, text, session) {
  const query = text.toLowerCase();

  // 1. Digital Brochure Request
  if (query.includes("brochure") || query.includes("pdf") || query.includes("catalog") || query.includes("details")) {
    const ackMsg = "I will send it over in a moment";
    await sendTextMessage(phone, ackMsg, getDynamicDelay(ackMsg));
    
    // Exact 10-Second Natural Wait
    await new Promise(r => setTimeout(r, 10000));
    
    await sendDocumentMessage(
      phone,
      PROJECT_ASSETS.brochure.url,
      PROJECT_ASSETS.brochure.filename,
      PROJECT_ASSETS.brochure.caption
    );
    await resumeQualificationPrompt(phone, session);
    return true;
  }

  // 2. Floor Plan / Master Layout Request
  if (query.includes("floor") || query.includes("plan") || query.includes("layout") || query.includes("map")) {
    const ackMsg = "I will send it over in a moment";
    await sendTextMessage(phone, ackMsg, getDynamicDelay(ackMsg));
    
    // Exact 10-Second Natural Wait
    await new Promise(r => setTimeout(r, 10000));
    
    await sendImageMessage(
      phone,
      PROJECT_ASSETS.floorPlan.url,
      PROJECT_ASSETS.floorPlan.caption
    );
    await resumeQualificationPrompt(phone, session);
    return true;
  }

  // 3. Payment Structure / Cost Breakdown Request
  if (query.includes("payment") || query.includes("cost") || query.includes("schedule") || query.includes("milestone") || query.includes("price sheet")) {
    const ackMsg = "I will send it over in a moment";
    await sendTextMessage(phone, ackMsg, getDynamicDelay(ackMsg));
    
    // Exact 10-Second Natural Wait
    await new Promise(r => setTimeout(r, 10000));
    
    await sendDocumentMessage(
      phone,
      PROJECT_ASSETS.paymentPlan.url,
      PROJECT_ASSETS.paymentPlan.filename,
      PROJECT_ASSETS.paymentPlan.caption
    );
    await resumeQualificationPrompt(phone, session);
    return true;
  }

  // 4. Video Tour Request
  if (query.includes("video") || query.includes("tour") || query.includes("walkthrough") || query.includes("3d")) {
    const ackMsg = "I will send it over in a moment";
    await sendTextMessage(phone, ackMsg, getDynamicDelay(ackMsg));
    
    await new Promise(r => setTimeout(r, 6000));
    await sendTextMessage(phone, `You can view the full 3D walkthrough video tour here: ${PROJECT_ASSETS.videoTour}`);
    await resumeQualificationPrompt(phone, session);
    return true;
  }

  return false;
}

// --- RESUME PROMPT HELPER (Keeps Buyer Moving Forward) ---
async function resumeQualificationPrompt(phone, session) {
  if (session.state === "AWAIT_FACING") {
    await sendButtonMessage(phone, "To share the exact availability, do you have any facing preference?", [
      { id: "FACING_EAST", title: "East" },
      { id: "FACING_WEST", title: "West" },
      { id: "FACING_NORTH", title: "North" }
    ], 2000);
  } else if (session.state === "AWAIT_BUDGET") {
    await sendListMessage(phone, "What is the budget that you are comfortable with?", "Select Budget", [
      {
        title: "Budget Range",
        rows: [
          { id: "BUDGET_1_75_2", title: "1.75 cr - 2 cr" },
          { id: "BUDGET_2_2_25", title: "2 cr - 2.25 cr" },
          { id: "BUDGET_2_25_2_5", title: "2.25 cr - 2.5 cr" },
          { id: "BUDGET_2_5_PLUS", title: "2.5 cr+" }
        ]
      }
    ], 2000);
  } else if (session.state === "AWAIT_SITE_VISIT_TYPE") {
    await sendButtonMessage(phone, "Would you prefer visiting the site during weekdays or weekends?", [
      { id: "VISIT_WEEKDAYS", title: "Weekdays" },
      { id: "VISIT_WEEKENDS", title: "Weekends" }
    ], 2000);
  }
}

// --- CONVERSATION FLOW ENGINE ---
async function handleUserFlow(phone, incomingText, incomingPayloadId, leadName = "Valued Buyer", project = "Raghava Projects", messageId = null) {
  // 1. Instant Blue Ticks
  if (messageId) await markMessageAsRead(messageId);

  let session = userSessions.get(phone);
  
  if (!session) {
    const assignedAgent = getNextAgent();
    session = {
      state: "INITIAL_CONTACT",
      name: leadName,
      project: project,
      answersCount: 0,
      assignedAgentId: assignedAgent.id,
      assignedAgentName: assignedAgent.name,
      data: {}
    };
    saveOrUpdateLead(phone, session);
  }

  const choice = incomingPayloadId || incomingText.trim();

  // 2. Asset & Document check
  const handledAsAsset = await handleAssetAndFaqQueries(phone, incomingText, session);
  if (handledAsAsset) {
    userSessions.set(phone, session);
    return;
  }

  // 3. Step-by-Step Flow
  switch (session.state) {
    case "INITIAL_CONTACT":
      const introMsg = `I'm Rahul from Raghava Projects. I think you inquired about ${session.project}. I'm just reaching out to give you some more details.`;
      await sendTextMessage(phone, introMsg, getDynamicDelay(introMsg));
      
      session.state = "AWAIT_FACING";
      await sendButtonMessage(phone, "Do you have any facing preference?", [
        { id: "FACING_EAST", title: "East" },
        { id: "FACING_WEST", title: "West" },
        { id: "FACING_NORTH", title: "North" }
      ], 1500);
      break;

    case "AWAIT_FACING":
      if (choice.includes("EAST") || choice.toLowerCase().includes("east")) {
        session.data.facing = "East";
        session.answersCount = 1;
        session.state = "AWAIT_SIZE";
        saveOrUpdateLead(phone, session);
        await sendListMessage(phone, "What unit size would you prefer?", "Select Size", [
          {
            title: "East Facing Sizes",
            rows: [
              { id: "SIZE_1855", title: "1855 sft" },
              { id: "SIZE_1952", title: "1952 sft" },
              { id: "SIZE_2284", title: "2284 sft" },
              { id: "SIZE_2388", title: "2388 sft" }
            ]
          }
        ], getDynamicDelay("What unit size would you prefer?"));
      } else if (choice.includes("WEST") || choice.toLowerCase().includes("west")) {
        session.data.facing = "West";
        session.data.size = "2044 sft";
        session.answersCount = 2;
        session.state = "AWAIT_BUDGET";
        saveOrUpdateLead(phone, session);
        const westMsg = "We have 2044 sft flats in west facing.";
        await sendTextMessage(phone, westMsg, getDynamicDelay(westMsg));
        await sendListMessage(phone, "What is the budget that you are comfortable with?", "Select Budget", [
          {
            title: "Budget Range",
            rows: [
              { id: "BUDGET_1_75_2", title: "1.75 cr - 2 cr" },
              { id: "BUDGET_2_2_25", title: "2 cr - 2.25 cr" },
              { id: "BUDGET_2_25_2_5", title: "2.25 cr - 2.5 cr" },
              { id: "BUDGET_2_5_PLUS", title: "2.5 cr+" }
            ]
          }
        ], 1500);
      } else if (choice.includes("NORTH") || choice.toLowerCase().includes("north")) {
        session.data.facing = "North";
        session.answersCount = 1;
        session.state = "AWAIT_SIZE";
        saveOrUpdateLead(phone, session);
        await sendButtonMessage(phone, "What unit size would you prefer?", [
          { id: "SIZE_1798", title: "1798 sft" },
          { id: "SIZE_1952", title: "1952 sft" }
        ], getDynamicDelay("What unit size would you prefer?"));
      }
      break;

    case "AWAIT_SIZE":
      session.data.size = choice.replace("SIZE_", "") + " sft";
      session.answersCount = 2;
      session.state = "AWAIT_BUDGET";
      saveOrUpdateLead(phone, session);
      await sendListMessage(phone, "What is the budget that you are comfortable with?", "Select Budget", [
        {
          title: "Budget Range",
          rows: [
            { id: "BUDGET_1_75_2", title: "1.75 cr - 2 cr" },
            { id: "BUDGET_2_2_25", title: "2 cr - 2.25 cr" },
            { id: "BUDGET_2_25_2_5", title: "2.25 cr - 2.5 cr" },
            { id: "BUDGET_2_5_PLUS", title: "2.5 cr+" }
          ]
        }
      ], getDynamicDelay("What is the budget that you are comfortable with?"));
      break;

    case "AWAIT_BUDGET":
      session.data.budget = choice.replace("BUDGET_", "");
      session.answersCount = 3;
      session.state = "AWAIT_SITE_VISIT_TYPE";
      saveOrUpdateLead(phone, session);
      const sitePitch = "See sir, our conversation is very end to end right now like what are the sizes ? and what are the prices.\n\nYou will get a complete idea about the project like the Amenities that you're getting once you do a site visit.";
      await sendButtonMessage(phone, sitePitch, [
        { id: "VISIT_WEEKDAYS", title: "Weekdays" },
        { id: "VISIT_WEEKENDS", title: "Weekends" }
      ], getDynamicDelay(sitePitch));
      break;

    case "AWAIT_SITE_VISIT_TYPE":
      if (choice.includes("WEEKDAYS") || choice.toLowerCase().includes("weekday")) {
        session.data.visitPreference = "Weekday";
        session.state = "AWAIT_VISIT_DAY";
        await sendListMessage(phone, "Please choose your preferred weekday for the site visit:", "Select Day", [
          {
            title: "Available Weekdays",
            rows: [
              { id: "DAY_MON", title: "Monday" },
              { id: "DAY_TUE", title: "Tuesday" },
              { id: "DAY_WED", title: "Wednesday" },
              { id: "DAY_THU", title: "Thursday" },
              { id: "DAY_FRI", title: "Friday" }
            ]
          }
        ], getDynamicDelay("Please choose your preferred weekday"));
      } else if (choice.includes("WEEKENDS") || choice.toLowerCase().includes("weekend")) {
        session.data.visitPreference = "Weekend";
        session.state = "AWAIT_VISIT_DAY";
        await sendButtonMessage(phone, "Please select your preferred weekend day:", [
          { id: "DAY_SAT", title: "Saturday" },
          { id: "DAY_SUN", title: "Sunday" }
        ], getDynamicDelay("Please select your preferred weekend day"));
      }
      break;

    case "AWAIT_VISIT_DAY":
      session.data.visitDay = choice.replace("DAY_", "");
      session.data.siteVisit = `${session.data.visitPreference} (${session.data.visitDay})`;
      session.answersCount = 4; // Complete flow -> HOT LEAD
      session.state = "COMPLETED";

      saveOrUpdateLead(phone, session);

      const doneMsg = "Done";
      const connectMsg = "Let's connect back in some time.";

      await sendTextMessage(phone, doneMsg, getDynamicDelay(doneMsg));
      await sendTextMessage(phone, connectMsg, getDynamicDelay(connectMsg));
      break;
  }

  userSessions.set(phone, session);
}

// --- API ENDPOINT FOR DASHBOARD SYNC ---
app.get('/api/leads', (req, res) => {
  res.json({ success: true, leads: qualifiedLeads });
});

// --- META WEBHOOK VERIFICATION ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- META WEBHOOK RECEIVER ---
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  // 1. Meta Lead Form Ads
  const leadgenEntry = req.body.entry?.[0]?.changes?.[0];
  if (leadgenEntry?.field === 'leadgen') {
    const leadgenId = leadgenEntry.value.leadgen_id;
    try {
      const leadData = await axios.get(`https://graph.facebook.com/v19.0/${leadgenId}?access_token=${META_ACCESS_TOKEN}`);
      const fields = leadData.data.field_data;
      const name = fields.find(f => f.name === 'full_name')?.values[0] || 'Valued Buyer';
      let phone = fields.find(f => f.name === 'phone_number')?.values[0] || '';
      phone = phone.replace(/\D/g, '');

      const assignedAgent = getNextAgent();
      const session = {
        state: "INITIAL_CONTACT",
        name: name,
        project: "Raghava Projects",
        answersCount: 0,
        assignedAgentId: assignedAgent.id,
        assignedAgentName: assignedAgent.name,
        data: {}
      };
      userSessions.set(phone, session);
      saveOrUpdateLead(phone, session);

      // 45-Second Human Delay before greeting
      setTimeout(async () => {
        await sendTextMessage(phone, `Hi ${name}, How are you?`, 0);
      }, 45000);
    } catch (e) {
      console.error("Meta Leadgen Fetch Error:", e.message);
    }
    return;
  }

  // 2. WhatsApp Inbound Messages
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0]?.value;
  const message = changes?.messages?.[0];

  if (!message) return;

  const from = message.from;
  const leadName = changes?.contacts?.[0]?.profile?.name || "Valued Buyer";
  let incomingText = "";
  let payloadId = null;

  if (message.type === 'text') {
    incomingText = message.text.body;
  } else if (message.type === 'interactive') {
    if (message.interactive.button_reply) {
      payloadId = message.interactive.button_reply.id;
      incomingText = message.interactive.button_reply.title;
    } else if (message.interactive.list_reply) {
      payloadId = message.interactive.list_reply.id;
      incomingText = message.interactive.list_reply.title;
    }
  }

  await handleUserFlow(from, incomingText, payloadId, leadName, "Raghava Projects", message.id);
});

// Manual Test Trigger Endpoint
app.post('/api/trigger-lead', async (req, res) => {
  const { phone, name, project } = req.body;
  const cleanPhone = phone.replace(/\D/g, '');
  const assignedAgent = getNextAgent();

  const session = {
    state: "INITIAL_CONTACT",
    name: name || "Valued Buyer",
    project: project || "Raghava Projects",
    answersCount: 0,
    assignedAgentId: assignedAgent.id,
    assignedAgentName: assignedAgent.name,
    data: {}
  };

  userSessions.set(cleanPhone, session);
  saveOrUpdateLead(cleanPhone, session);

  res.json({ success: true, message: "Lead queued in round-robin stream." });
});

app.listen(PORT, () => console.log(`Raghava Webhook Engine running on port ${PORT}`));