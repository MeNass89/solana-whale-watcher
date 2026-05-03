import { render } from "preact";
import { App } from "./app.js";
import "./styles/global.css";

render(<App />, document.getElementById("app")!);
