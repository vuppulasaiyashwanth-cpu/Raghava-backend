// Simple In-Memory State Tracker
const userSessions = {};

// Send Next Question: BHK Preference
async function askBHKPreference(toPhone, zoneName) {
  const cleanPhone = toPhone.toString().replace(/\D/g, '');
  
  await callWhatsAppAPI({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: `Great choice! For ${zoneName}, what configuration are you looking for?`
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'bhk_3', title: '3 BHK' } },
          { type: 'reply', reply: { id: 'bhk_4', title: '4 BHK' } },
          { type: 'reply', reply: { id: 'bhk_sky_villa', title: 'Sky Villa' } }
        ]
      }
    }
  });
}

// Send Final Confirmation & Site Visit Question
async function askSiteVisit(toPhone) {
  const cleanPhone = toPhone.toString().replace(/\D/g, '');
  
  await callWhatsAppAPI({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: `Thank you! Would you like to schedule an exclusive site visit this weekend?`
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'visit_yes', title: 'Yes, Schedule Visit' } },
          { type: 'reply', reply: { id: 'visit_brochure', title: 'Send Brochure Only' } }
        ]
      }
    }
  });
}
