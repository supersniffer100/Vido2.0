# Vido

Vido is a local-only video platform inspired by YouTube.

## What it does

- Lets you change your display name
- Lets you upload a profile picture
- Lets you upload `.mp4` videos
- Shows videos on the main menu until the first 100 uploads fill those slots
- Keeps later uploads searchable, but hidden from the main menu
- Stores profile data and videos locally inside the `data/` folder

## Run it

```powershell
npm start
```

Then open `http://localhost:3000`.

## Local storage

- Profile data: `data/db.json`
- Profile pictures: `data/profile-pictures/`
- Videos: `data/videos/`

## Notes

- This is a local app for one computer and one local profile right now.
- Video uploads are sent from the browser as base64 JSON, so very large files may feel slower than a production video site.
