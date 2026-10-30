import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/globals.css";
import "@/desktop.css";
import { installApiShim } from "@/lib/apiShim";
import { Widget } from "@/widget/Widget";

installApiShim();

createRoot(document.getElementById("widget")!).render(
  <StrictMode>
    <Widget />
  </StrictMode>,
);
