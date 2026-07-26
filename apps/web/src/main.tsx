import { render } from "solid-js/web";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./styles/app.css";

registerSW({ immediate: true });

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
render(() => <App />, root);
