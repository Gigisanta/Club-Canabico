export async function registerDeliveryPwa(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof document === "undefined") return undefined;
  let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "manifest";
    document.head.append(link);
  }
  link.href = "/manifest.webmanifest";
  link.dataset.bomboDelivery = "true";
  if (!("serviceWorker" in navigator)) return undefined;
  return navigator.serviceWorker.register("/bombo-sw.js", { scope: "/" });
}
