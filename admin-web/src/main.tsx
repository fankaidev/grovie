import type { ReactNode } from "react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { cn } from "./lib/utils";
import "./styles.css";

function App(): ReactNode {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-8">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Local admin console</p>
            <h1 className="text-3xl font-semibold tracking-tight">Grovie</h1>
          </div>
          <div className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
            Served by the local daemon
          </div>
        </header>

        <div className="grid gap-4 md:grid-cols-3">
          <StatusTile icon="D" label="Daemon" value="Local process" />
          <StatusTile icon="R" label="Runs" value="API backed" />
          <StatusTile icon="G" label="Control plane" value="GitHub native" />
        </div>

        <section className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-lg font-semibold">Admin web shell</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              This React shell is served from the Grovie daemon process. Existing admin APIs remain available under
              <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-foreground">/api</code>
              while the browser app owns local routes such as
              <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-foreground">/runs/:runId</code>.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-lg font-semibold">Runtime boundary</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Built assets come from the root build output, so production serving does not depend on Vite.
            </p>
          </div>
        </section>
      </section>
    </main>
  );
}

function StatusTile(props: { icon: string; label: string; value: string }): ReactNode {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <span className={cn("flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground")}>
          {props.icon}
        </span>
        <div>
          <p className="text-sm text-muted-foreground">{props.label}</p>
          <p className="font-medium">{props.value}</p>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
