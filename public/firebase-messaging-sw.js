/* eslint-disable no-undef */
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

let messagingInstance = null;
let backgroundHandlerRegistered = false;

const initializeMessaging = (config) => {
  if (!config || typeof config !== 'object') {
    return;
  }

  if (firebase.apps.length === 0) {
    firebase.initializeApp(config);
  }

  if (firebase.messaging.isSupported()) {
    messagingInstance = firebase.messaging();

    if (!backgroundHandlerRegistered) {
      messagingInstance.onBackgroundMessage((payload) => {
        const notificationTitle = payload.notification?.title ?? '백그라운드 메시지';
        const notificationOptions = {
          body: payload.notification?.body ?? '',
          icon: payload.notification?.icon ?? '/vite.svg',
          data: payload.data ?? {}
        };

        self.registration.showNotification(notificationTitle, notificationOptions);
      });

      backgroundHandlerRegistered = true;
    }
  }
};

self.addEventListener('message', (event) => {
  if (event.data?.type === 'INIT_FIREBASE') {
    initializeMessaging(event.data.config);
  }
});

self.addEventListener('push', (event) => {
  if (messagingInstance) {
    return;
  }

  if (!event.data) {
    return;
  }

  try {
    const payload = event.data.json();
    const notificationTitle = payload.notification?.title ?? '푸시 알림';
    const notificationOptions = {
      body: payload.notification?.body ?? '',
      icon: payload.notification?.icon ?? '/vite.svg'
    };

    event.waitUntil(self.registration.showNotification(notificationTitle, notificationOptions));
  } catch (error) {
    console.error('[firebase-messaging-sw] Failed to display fallback notification', error);
  }
});
