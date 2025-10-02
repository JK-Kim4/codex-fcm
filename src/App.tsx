import { useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteApp,
  getApps,
  initializeApp,
  type FirebaseApp
} from 'firebase/app';
import {
  getMessaging,
  getToken,
  isSupported,
  onMessage,
  type MessagePayload,
  type Messaging
} from 'firebase/messaging';
import './App.css';

interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

interface PushMessagePayload {
  title: string;
  body: string;
  imageUrl: string;
  data: string;
}

const LOCAL_STORAGE_KEY = 'fcm-webpush-settings';

const defaultConfig: FirebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: ''
};

type StatusMessage = {
  type: 'info' | 'success' | 'error';
  text: string;
  timestamp: number;
};

function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as {
      config: FirebaseConfig;
      vapidKey: string;
      serverKey: string;
    };
  } catch (error) {
    console.error('Failed to load saved settings', error);
    return null;
  }
}

function saveSettings(config: FirebaseConfig, vapidKey: string, serverKey: string) {
  localStorage.setItem(
    LOCAL_STORAGE_KEY,
    JSON.stringify({ config, vapidKey, serverKey })
  );
}

function parseDataPayload(data: string) {
  if (!data.trim()) return undefined;
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new Error('데이터(JSON) 형식이 올바르지 않습니다.');
  }
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(timestamp);
}

const initialPushPayload: PushMessagePayload = {
  title: '웹 푸시 테스트',
  body: 'FCM에서 전송한 알림입니다.',
  imageUrl: '',
  data: '{"foo":"bar"}'
};

const App = () => {
  const [firebaseConfig, setFirebaseConfig] = useState<FirebaseConfig>(defaultConfig);
  const [vapidKey, setVapidKey] = useState('');
  const [serverKey, setServerKey] = useState('');
  const [firebaseApp, setFirebaseApp] = useState<FirebaseApp | null>(null);
  const [messaging, setMessaging] = useState<Messaging | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const [token, setToken] = useState('');
  const [statusMessages, setStatusMessages] = useState<StatusMessage[]>([]);
  const [pushPayload, setPushPayload] = useState(initialPushPayload);
  const [targetToken, setTargetToken] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string>('');
  const [foregroundMessages, setForegroundMessages] = useState<
    { payload: MessagePayload; receivedAt: number }[]
  >([]);
  const vapidKeyInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const saved = loadSavedSettings();
    if (saved) {
      setFirebaseConfig(saved.config);
      setVapidKey(saved.vapidKey);
      setServerKey(saved.serverKey);
    }
  }, []);

  useEffect(() => {
    if (!messaging) return;
    const unsubscribe = onMessage(messaging, (payload) => {
      setForegroundMessages((prev) => [{ payload, receivedAt: Date.now() }, ...prev]);
      appendStatus('success', '포그라운드 메시지를 수신했습니다.');
    });
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messaging]);

  const appendStatus = (type: StatusMessage['type'], text: string) => {
    setStatusMessages((prev) => [{ type, text, timestamp: Date.now() }, ...prev]);
  };

  const handleConfigChange = (key: keyof FirebaseConfig, value: string) => {
    setFirebaseConfig((prev) => ({ ...prev, [key]: value }));
  };

  const ensureServiceWorkerRegistration = async () => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('서비스 워커를 지원하지 않는 환경입니다.');
    }

    const existingRegistration = await navigator.serviceWorker.getRegistration('/firebase-messaging-sw.js');
    if (existingRegistration) {
      const worker = existingRegistration.active || existingRegistration.waiting;
      if (worker) {
        worker.postMessage({
          type: 'INIT_FIREBASE',
          config: firebaseConfig
        });
      }
      return existingRegistration;
    }

    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    const registrationReady = await new Promise<ServiceWorkerRegistration>((resolve) => {
      if (registration.active) {
        resolve(registration);
        return;
      }

      const serviceWorker = registration.installing || registration.waiting;
      if (!serviceWorker) {
        resolve(registration);
        return;
      }

      serviceWorker.addEventListener('statechange', () => {
        if (serviceWorker.state === 'activated') {
          resolve(registration);
        }
      });
    });

    const worker = registrationReady.active || registrationReady.waiting;
    worker?.postMessage({
      type: 'INIT_FIREBASE',
      config: firebaseConfig
    });

    return registrationReady;
  };

  const handleInitializeFirebase = async () => {
    setIsInitializing(true);
    setSendResult('');
    try {
      const supported = await isSupported();
      if (!supported) {
        appendStatus('error', '이 브라우저에서는 FCM 웹 푸시를 지원하지 않습니다.');
        return;
      }

      saveSettings(firebaseConfig, vapidKey, serverKey);

      const apps = getApps();
      if (apps.length > 0) {
        await Promise.all(apps.map((app) => deleteApp(app)));
        appendStatus('info', '기존 Firebase 앱 구성을 초기화했습니다.');
      }

      const app = initializeApp(firebaseConfig);
      const messagingInstance = getMessaging(app);

      await ensureServiceWorkerRegistration();

      setFirebaseApp(app);
      setMessaging(messagingInstance);
      appendStatus('success', 'Firebase 초기화 및 서비스 워커 구성이 완료되었습니다.');
    } catch (error: any) {
      console.error(error);
      appendStatus('error', error?.message ?? 'Firebase 초기화에 실패했습니다.');
    } finally {
      setIsInitializing(false);
    }
  };

  const handleRequestPermissionAndToken = async () => {
    if (!messaging) {
      appendStatus('error', 'Firebase 메시징이 초기화되지 않았습니다. 먼저 초기화를 진행해주세요.');
      return;
    }

    if (!vapidKey.trim()) {
      appendStatus('error', 'VAPID 키를 입력해주세요.');
      vapidKeyInputRef.current?.focus();
      return;
    }

    try {
      if (typeof Notification === 'undefined') {
        appendStatus('error', '이 브라우저에서는 알림 API를 지원하지 않습니다.');
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        appendStatus('error', '알림 권한을 허용하지 않아 토큰을 발급할 수 없습니다.');
        return;
      }

      const registration = await ensureServiceWorkerRegistration();
      const currentToken = await getToken(messaging, {
        vapidKey: vapidKey.trim(),
        serviceWorkerRegistration: registration
      });

      if (!currentToken) {
        appendStatus('error', '토큰 발급에 실패했습니다.');
        return;
      }

      setToken(currentToken);
      setTargetToken(currentToken);
      appendStatus('success', 'FCM 등록 토큰을 발급했습니다.');
    } catch (error: any) {
      console.error(error);
      appendStatus('error', error?.message ?? '토큰 발급 중 오류가 발생했습니다.');
    }
  };

  const handleCopyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      appendStatus('success', '토큰을 클립보드에 복사했습니다.');
    } catch (error) {
      appendStatus('error', '토큰 복사에 실패했습니다.');
    }
  };

  const handleSendPush = async () => {
    setSendResult('');
    if (!serverKey.trim()) {
      appendStatus('error', '서버 키(legacy key)를 입력해주세요.');
      return;
    }

    if (!targetToken.trim()) {
      appendStatus('error', '전송할 대상 토큰을 입력해주세요.');
      return;
    }

    let dataPayload: Record<string, unknown> | undefined;
    try {
      dataPayload = parseDataPayload(pushPayload.data);
    } catch (error: any) {
      appendStatus('error', error.message);
      return;
    }

    const body: Record<string, unknown> = {
      to: targetToken.trim(),
      notification: {
        title: pushPayload.title,
        body: pushPayload.body,
        image: pushPayload.imageUrl || undefined
      }
    };

    if (dataPayload) {
      body.data = dataPayload;
    }

    setSending(true);
    try {
      const response = await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `key=${serverKey.trim()}`
        },
        body: JSON.stringify(body)
      });

      const resultText = await response.text();

      if (!response.ok) {
        throw new Error(`FCM 전송 실패 (${response.status}): ${resultText}`);
      }

      setSendResult(resultText);
      appendStatus('success', '푸시 메시지 전송 요청을 완료했습니다.');
    } catch (error: any) {
      console.error(error);
      const message =
        '푸시 전송 요청 중 오류가 발생했습니다. 브라우저에서 CORS로 인해 실패할 수 있으며, 이 경우 서버 사이드 프록시를 이용해야 합니다.';
      appendStatus('error', message);
      setSendResult(error?.message ?? '오류가 발생했습니다.');
    } finally {
      setSending(false);
    }
  };

  const resetFirebase = async () => {
    setToken('');
    setForegroundMessages([]);
    if (firebaseApp) {
      try {
        await deleteApp(firebaseApp);
        appendStatus('info', 'Firebase 앱 인스턴스를 해제했습니다.');
      } catch (error) {
        console.error('Failed to delete Firebase app', error);
      } finally {
        setFirebaseApp(null);
        setMessaging(null);
      }
    }
  };

  const configIsComplete = useMemo(
    () => Object.values(firebaseConfig).every((value) => value.trim().length > 0),
    [firebaseConfig]
  );

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>Firebase Cloud Messaging 웹 푸시 테스트</h1>
          <p className="app__description">
            Firebase 프로젝트 설정을 입력하고 토큰을 발급받은 뒤, 간단한 테스트 푸시를 전송해볼 수 있습니다.
          </p>
        </div>
        <div className="app__header-actions">
          <button type="button" className="secondary" onClick={resetFirebase}>
            초기화 해제
          </button>
        </div>
      </header>

      <main className="app__content">
        <section className="card">
          <h2>1. Firebase 프로젝트 설정</h2>
          <p className="card__description">
            Firebase 콘솔 &gt; 프로젝트 설정 &gt; 일반 탭에서 웹 앱 구성 정보를 입력해주세요.
          </p>
          <div className="grid">
            <label>
              <span>apiKey</span>
              <input
                type="text"
                value={firebaseConfig.apiKey}
                onChange={(event) => handleConfigChange('apiKey', event.target.value)}
                placeholder="AIzaSy..."
              />
            </label>
            <label>
              <span>authDomain</span>
              <input
                type="text"
                value={firebaseConfig.authDomain}
                onChange={(event) => handleConfigChange('authDomain', event.target.value)}
                placeholder="your-project.firebaseapp.com"
              />
            </label>
            <label>
              <span>projectId</span>
              <input
                type="text"
                value={firebaseConfig.projectId}
                onChange={(event) => handleConfigChange('projectId', event.target.value)}
                placeholder="your-project-id"
              />
            </label>
            <label>
              <span>storageBucket</span>
              <input
                type="text"
                value={firebaseConfig.storageBucket}
                onChange={(event) => handleConfigChange('storageBucket', event.target.value)}
                placeholder="your-project.appspot.com"
              />
            </label>
            <label>
              <span>messagingSenderId</span>
              <input
                type="text"
                value={firebaseConfig.messagingSenderId}
                onChange={(event) => handleConfigChange('messagingSenderId', event.target.value)}
                placeholder="1234567890"
              />
            </label>
            <label>
              <span>appId</span>
              <input
                type="text"
                value={firebaseConfig.appId}
                onChange={(event) => handleConfigChange('appId', event.target.value)}
                placeholder="1:1234567890:web:abcdef123456"
              />
            </label>
          </div>
          <label>
            <span>웹 푸시 인증서(VAPID) 공개키</span>
            <input
              ref={vapidKeyInputRef}
              type="text"
              value={vapidKey}
              onChange={(event) => setVapidKey(event.target.value)}
              placeholder="BBO..."
            />
          </label>
          <div className="card__actions">
            <button
              type="button"
              disabled={!configIsComplete || isInitializing}
              onClick={handleInitializeFirebase}
            >
              {isInitializing ? '초기화 중...' : '설정 저장 및 초기화'}
            </button>
          </div>
        </section>

        <section className="card">
          <h2>2. 브라우저 권한 및 토큰 발급</h2>
          <p className="card__description">
            알림 권한을 허용하고 웹 푸시 토큰을 발급받습니다.
          </p>
          <div className="card__actions">
            <button type="button" onClick={handleRequestPermissionAndToken}>
              알림 권한 요청 &amp; 토큰 발급
            </button>
            <button type="button" className="secondary" onClick={handleCopyToken} disabled={!token}>
              토큰 복사
            </button>
          </div>
          <label>
            <span>현재 발급된 토큰</span>
            <textarea readOnly rows={4} value={token} placeholder="토큰이 여기에 표시됩니다." />
          </label>
        </section>

        <section className="card">
          <h2>3. 푸시 메시지 전송 테스트</h2>
          <p className="card__description">
            테스트용으로 legacy HTTP 엔드포인트를 호출합니다. 실제 운영 환경에서는 서버에서 Access Token을 발급하여 HTTP v1 API를 사용하는 것을 권장합니다.
          </p>
          <label>
            <span>서버 키 (Legacy server key)</span>
            <input
              type="password"
              value={serverKey}
              onChange={(event) => setServerKey(event.target.value)}
              placeholder="AAAAA..."
            />
          </label>
          <label>
            <span>전송 대상 토큰</span>
            <textarea
              rows={3}
              value={targetToken}
              onChange={(event) => setTargetToken(event.target.value)}
              placeholder="푸시를 받을 디바이스 토큰을 입력하세요."
            />
          </label>
          <div className="grid grid--compact">
            <label>
              <span>알림 제목</span>
              <input
                type="text"
                value={pushPayload.title}
                onChange={(event) => setPushPayload((prev) => ({ ...prev, title: event.target.value }))}
              />
            </label>
            <label>
              <span>알림 내용</span>
              <input
                type="text"
                value={pushPayload.body}
                onChange={(event) => setPushPayload((prev) => ({ ...prev, body: event.target.value }))}
              />
            </label>
          </div>
          <label>
            <span>이미지 URL (선택)</span>
            <input
              type="url"
              value={pushPayload.imageUrl}
              onChange={(event) => setPushPayload((prev) => ({ ...prev, imageUrl: event.target.value }))}
              placeholder="https://example.com/image.png"
            />
          </label>
          <label>
            <span>데이터 페이로드 (JSON)</span>
            <textarea
              rows={4}
              value={pushPayload.data}
              onChange={(event) => setPushPayload((prev) => ({ ...prev, data: event.target.value }))}
              placeholder='{"foo":"bar"}'
            />
          </label>
          <div className="card__actions">
            <button type="button" onClick={handleSendPush} disabled={sending}>
              {sending ? '전송 중...' : 'FCM 전송 요청'}
            </button>
          </div>
          {sendResult && (
            <div className="result">
              <h3>전송 결과</h3>
              <pre>{sendResult}</pre>
            </div>
          )}
        </section>

        <section className="card">
          <h2>수신 이력</h2>
          {foregroundMessages.length === 0 ? (
            <p className="card__description">수신한 포그라운드 메시지가 없습니다.</p>
          ) : (
            <ul className="messages">
              {foregroundMessages.map(({ payload, receivedAt }, index) => (
                <li key={`${receivedAt}-${index}`}>
                  <header>
                    <strong>{payload.notification?.title ?? '제목 없음'}</strong>
                    <span>{formatDate(receivedAt)}</span>
                  </header>
                  <p>{payload.notification?.body ?? '내용 없음'}</p>
                  {payload.data && (
                    <details>
                      <summary>데이터</summary>
                      <pre>{JSON.stringify(payload.data, null, 2)}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>활동 로그</h2>
          {statusMessages.length === 0 ? (
            <p className="card__description">아직 기록된 로그가 없습니다.</p>
          ) : (
            <ul className="logs">
              {statusMessages.map((status) => (
                <li key={status.timestamp} className={`logs__item logs__item--${status.type}`}>
                  <span>{formatDate(status.timestamp)}</span>
                  <p>{status.text}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="app__footer">
        <p>
          ⚠️ 브라우저에서 직접 legacy server key를 사용하는 것은 보안상 위험할 수 있으니 테스트 용도로만 사용하고, 실제 서비스에서는 안전한 서버 환경에서 HTTP v1 API를 이용하세요.
        </p>
      </footer>
    </div>
  );
};

export default App;
