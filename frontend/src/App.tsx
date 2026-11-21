import { useEffect, useState } from "react";
import './App.css'

function App() {
    const [backendStatus, setBackendStatus] = useState("Checking...");

  useEffect(() => {
    fetch("http://127.0.0.1:8000/health")
      .then((response) => {
        if (!response.ok) {
          throw new Error("Backend unavailable");
        }
        return response.json();
      })
      .then((data) => setBackendStatus(data.status))
      .catch(() => setBackendStatus("Disconnected"));
  }, []);


  return (
    <div className="app">
      <header className="header">
        <h1>🎸 GuitarLab AI</h1>
        <span>AI-powered guitar learning studio</span>
      </header>

      <main className="dashboard">
        <section className="welcome">
          <h2>Welcome to your practice studio</h2>
          <p>
            Analyse songs, isolate guitar tracks and improve your playing
            with AI.
          </p>
        </section>

        <section className="features">
          <div className="feature-card">
            <h3>🎵 Song Library</h3>
            <p>Import and manage your favourite songs.</p>
          </div>

          <div className="feature-card">
            <h3>🎚️ Audio Workspace</h3>
            <p>Slow down, loop and analyse recordings.</p>
          </div>

          <div className="feature-card">
            <h3>🎸 Guitar Stems</h3>
            <p>Separate guitar, bass, drums and vocals.</p>
          </div>

          <div className="feature-card">
            <h3>📖 Practice Studio</h3>
            <p>Save licks, study tablature and create exercises.</p>
          </div>
        </section>

        <section className="status">
          <h3>System status</h3>
          <p>Frontend: Running</p>
          <p>Backend: {backendStatus}</p>
        </section>
      </main>
    </div>
  );
}

export default App;
