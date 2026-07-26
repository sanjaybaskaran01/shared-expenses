import { render } from "solid-js/web";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./styles/app.css";

registerSW({
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent("expenses:update-available"));
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
render(() => <App />, root);
