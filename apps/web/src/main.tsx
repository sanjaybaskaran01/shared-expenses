import { render } from "solid-js/web";
import App from "./App";
import { apiBaseUrl } from "./lib/api";
import { developmentIdentity } from "./lib/development-actor";
import { initReleaseWatch } from "./lib/release-watch";
import "./styles/app.css";

if ("serviceWorker" in navigator) {
  if (import.meta.env.DEV) {
    void navigator.serviceWorker.getRegistrations().then((registrations) =>
      Promise.all(registrations.map((registration) => registration.unregister())),
    );
    if ("caches" in window) {
      void caches.keys().then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("tally-shell-") || name.startsWith("tallied-shell-"))
            .map((name) => caches.delete(name)),
        ),
      );
    }
  } else {
    window.addEventListener("load", () => {
      const workerUrl = new URL("/tally-sw.js", location.origin);
      workerUrl.searchParams.set("api", apiBaseUrl);
      void navigator.serviceWorker.register(workerUrl, { updateViaCache: "none" }).then((registration) => {
        void initReleaseWatch(registration);
      });
    });
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
render(() => <App />, root);

if (import.meta.env.DEV) {
  const identity = developmentIdentity(location.search, true);
  if (identity.scenario) {
    void import("./lib/scenario-bridge").then(({ installScenarioBridge }) => installScenarioBridge(identity.actorId));
  }
}
