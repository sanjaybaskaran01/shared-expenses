import { render } from "solid-js/web";
import App from "./App";
import "./styles/app.css";

if ("serviceWorker" in navigator) {
  if (import.meta.env.DEV) {
    void navigator.serviceWorker.getRegistrations().then((registrations) =>
      Promise.all(registrations.map((registration) => registration.unregister())),
    );
    if ("caches" in window) {
      void caches.keys().then((names) =>
        Promise.all(names.filter((name) => name.startsWith("tally-shell-")).map((name) => caches.delete(name))),
      );
    }
  } else {
    window.addEventListener("load", () => {
      void navigator.serviceWorker.register("/tally-sw.js", { updateViaCache: "none" });
    });
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
render(() => <App />, root);
