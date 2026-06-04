# 🏸 RallyPlayer - Badminton Video & Analysis Studio

RallyPlayer is a badminton match analysis video player and dashboard built using a monorepo setup powered by **Nx**, featuring an **Angular** frontend and a **NestJS** backend. It dynamically pulls live tournaments, player rankings, and video stream feeds, utilizing `yt-dlp` for video stream extraction.

---

## 🛠️ Project Structure

The project is structured as an Nx workspace with separate frontend and backend applications:

*   **`apps/client`**: An Angular application configured with Server-Side Rendering (SSR) for the user interface and video player.
*   **`apps/server`**: A NestJS API backend handling YouTube searches, rankings scraping, and video link resolver logic.

---

## 📋 Prerequisites

Before running the project, make sure you have the following installed on your local machine:

1.  **Node.js** (v18 or higher recommended)
2.  **yt-dlp**: Used by the backend to fetch YouTube search feeds and direct stream URLs.
    *   **macOS (via Homebrew):**
        ```bash
        brew install yt-dlp
        ```
    *   **Windows (via Winget):**
        ```powershell
        winget install yt-dlp
        ```
    *   **Linux (Debian/Ubuntu):**
        ```bash
        sudo apt update && sudo apt install yt-dlp
        ```
    *   *Note: Ensure `yt-dlp` is added to your system's global `PATH`.*

---

## 🚀 Getting Started

Follow these steps to set up and launch the project locally:

### 1. Install Dependencies
Navigate to the root directory of the project and install the NPM packages:
```bash
npm install
```

### 2. Start Development Servers
You can run both the frontend and backend applications simultaneously, or start them individually.

#### Option A: Run Both Applications (Recommended)
Launch the frontend and backend in development mode together using:
```bash
npx nx run-many -t serve
```

#### Option B: Run Individually
*   **Start the NestJS Backend (`server`):**
    ```bash
    npx nx serve server
    ```
    *Runs on [http://localhost:3003/api](http://localhost:3003/api)*

*   **Start the Angular Frontend (`client`):**
    ```bash
    npx nx serve client
    ```
    *Runs on [http://localhost:4200](http://localhost:4200)*

---

## ⚙️ Additional Commands

Use the following Nx commands to maintain and build the project:

### Build for Production
Build both applications for production:
```bash
npx nx run-many -t build
```
The compiled output will be placed in the `dist/` folder:
*   Frontend bundle: `dist/apps/client/browser` (and `dist/apps/client/server` for SSR)
*   Backend bundle: `dist/apps/server/main.js`

### Run Linting
Check code quality across all applications:
```bash
npx nx run-many -t lint
```

### Run Unit Tests
Execute unit tests via Vitest:
```bash
npx nx run-many -t test
```
