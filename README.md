# CompanionCommons Phase 0

Independent pet health logging platform. SMS-based weekly check-ins, simple dashboard, community-driven.

## Folder Structure

```
companioncommons/
├── package.json
├── server.js
├── .gitignore
├── README.md
└── public/
    └── index.html
```

## Setup

1. Create a `public` folder inside `companioncommons/`
2. Save `index.html` inside the `public/` folder
3. Run: `npm install`
4. Run: `npm start`
5. Visit: http://localhost:3000

## Week 1 Checklist

- [x] Landing page hosted
- [ ] Signup form connects to API
- [ ] SMS system configured
- [ ] Database integration
- [ ] Dashboard built

## API Endpoints (Phase 0)

- `GET /` - Landing page
- `GET /api/health` - Server status
- `POST /api/signup` - User signup (placeholder)
- `POST /api/survey` - Survey submission (placeholder)
- `GET /api/dashboard/:userId` - Pet dashboard (placeholder)

## Deployment

1. Push to GitHub: `git push origin main`
2. Replit auto-deploys from GitHub
3. Domain: companioncommons.com (DNS configured)
