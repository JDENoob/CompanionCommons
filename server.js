const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files (your HTML, CSS, etc.)
app.use(express.static('public'));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'CompanionCommons Phase 0 is running' });
});

// Placeholder signup endpoint (Phase 0 - just logs, doesn't save to DB yet)
app.post('/api/signup', (req, res) => {
  const { email, petName, breed, age } = req.body;
  console.log(`New signup: ${petName} (${breed}), ${age} years old, from ${email}`);
  res.json({ 
    success: true, 
    message: 'Thanks for joining! We will send SMS reminders soon.',
    petName: petName
  });
});

// Placeholder survey endpoint (Phase 0 - just logs)
app.post('/api/survey', (req, res) => {
  const { userId, petId, responses } = req.body;
  console.log(`Survey received from user ${userId}, pet ${petId}:`, responses);
  res.json({ 
    success: true, 
    message: 'Survey recorded. Thanks for logging!'
  });
});

// Dashboard placeholder (Phase 1 - will query database)
app.get('/api/dashboard/:userId', (req, res) => {
  const { userId } = req.params;
  res.json({ 
    userId: userId,
    petName: 'Buddy',
    surveyCount: 0,
    improvementPercent: 0,
    message: 'Dashboard coming in Phase 1'
  });
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`CompanionCommons Phase 0 running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to test locally`);
});
