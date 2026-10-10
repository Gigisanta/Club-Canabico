import { Component, type ReactNode } from "react";

type LazyImportBoundaryProps = {
  children: ReactNode;
  active?: boolean;
};

type LazyImportBoundaryState = {
  failed: boolean;
};

export class LazyImportBoundary extends Component<LazyImportBoundaryProps, LazyImportBoundaryState> {
  state: LazyImportBoundaryState = { failed: false };

  static getDerivedStateFromError(_error: unknown): LazyImportBoundaryState {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      if (this.props.active === false) return null;
      return (
        <section className="page-loading" role="alert" aria-labelledby="lazy-import-error-title">
          <div>
            <h2 id="lazy-import-error-title">No pudimos abrir esta parte</h2>
            <p>Guardá los cambios pendientes antes de actualizar la página para volver a intentarlo.</p>
            <button className="button" type="button" onClick={() => window.location.reload()}>
              Actualizar página
            </button>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
