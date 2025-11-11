import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { OPENAI_API_KEY, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_DESKTOP_CLIENT_ID, GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET } from './config';

declare global {
  interface Window {
    google?: any;
    __TAURI__?: any;
  }
}

type GmailEmail = {
  id: string;
  threadId?: string;
  messageId?: string;
  subject: string;
  sender: string;
  snippet: string;
  body: string;
  internalDate?: string;
};

type EmailAnalysis = {
  summary: string;
  category: 'Urgent' | 'Action Needed' | 'Waiting on Others' | 'FYI';
  priority: number;
  action_items: string[];
  deadlines: string[];
  key_points: string[];
};

type ReplyDraftState = {
  loading: boolean;
  content: string;
  error?: string;
  draftId?: string;
  savedAt?: string;
  saving?: boolean;
  sending?: boolean;
  dirty?: boolean;
  notice?: string;
};

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const GMAIL_SCOPE = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

const CATEGORY_COLORS: Record<string, string> = {
  Urgent: 'bg-red-100/80 text-red-700',
  'Action Needed': 'bg-orange-100/80 text-orange-700',
  'Waiting on Others': 'bg-blue-100/80 text-blue-700',
  FYI: 'bg-emerald-100/80 text-emerald-700',
};

const defaultAnalysis: EmailAnalysis = {
  summary: '',
  category: 'FYI',
  priority: 5,
  action_items: [],
  deadlines: [],
  key_points: [],
};

const digestTemplates = {
  morning: 'Morning briefing highlighting urgent work and deadlines for the day.',
  evening: 'Evening recap summarizing progress and open loops to revisit tomorrow.',
};

const EmailProductivityDashboard: React.FC = () => {
  const openAiKey = (OPENAI_API_KEY || '').trim();
  const gmailClientId = (GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const [gmailStatus, setGmailStatus] = useState<{
    loading: boolean;
    connected: boolean;
    error: string;
    profile?: string;
    lastSync?: string;
  }>({
    loading: false,
    connected: false,
    error: '',
  });
  const [gisReady, setGisReady] = useState(false);
  const [googleToken, setGoogleToken] = useState('');

  // Load saved token on mount and auto-fetch emails
  useEffect(() => {
    const savedToken = localStorage.getItem('gmail_access_token');
    const savedProfile = localStorage.getItem('gmail_profile');
    if (savedToken) {
      setGoogleToken(savedToken);
      setGmailStatus({
        loading: true,
        connected: true,
        error: '',
        profile: savedProfile || 'Connected',
        // Don't set lastSync during loading to avoid "Invalid Date" display
      });
      // Auto-fetch emails on startup
      fetchEmails(savedToken).catch(async (error) => {
        console.log('Initial fetch failed, attempting token refresh:', error);
        // If fetch fails, try to refresh the token
        const refreshToken = localStorage.getItem('gmail_refresh_token');
        if (refreshToken) {
          await refreshAccessToken(refreshToken);
        } else {
          setGmailStatus((prev) => ({ ...prev, connected: false, loading: false, error: 'Session expired. Please reconnect.' }));
        }
      });
    }
  }, []);

  // Auto-refresh emails every 5 minutes
  useEffect(() => {
    if (!googleToken) return;

    const intervalId = setInterval(() => {
      console.log('Auto-refreshing emails...');
      fetchEmails(googleToken).catch((error) => {
        console.log('Auto-refresh failed:', error);
        // Try to refresh token if fetch fails
        const refreshToken = localStorage.getItem('gmail_refresh_token');
        if (refreshToken) {
          refreshAccessToken(refreshToken);
        }
      });
    }, 5 * 60 * 1000); // 5 minutes

    return () => clearInterval(intervalId);
  }, [googleToken]);

  const refreshAccessToken = async (refreshToken: string) => {
    try {
      const isTauri = typeof window.__TAURI__ !== 'undefined';
      const clientId = isTauri ? (GOOGLE_OAUTH_DESKTOP_CLIENT_ID || gmailClientId) : gmailClientId;
      const clientSecret = isTauri ? GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET : undefined;

      const params: any = {
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      };

      if (clientSecret) {
        params.client_secret = clientSecret;
      }

      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });

      const data = await response.json();

      if (data.access_token) {
        const newToken = data.access_token;
        setGoogleToken(newToken);
        localStorage.setItem('gmail_access_token', newToken);
        // Clear previous error
        setGmailStatus((prev) => ({ ...prev, error: '', connected: true }));
        await fetchEmails(newToken);
      } else {
        throw new Error(data.error_description || 'Failed to refresh token');
      }
    } catch (error) {
      console.error('Token refresh failed:', error);
      // Clear invalid tokens
      setGoogleToken('');
      localStorage.removeItem('gmail_access_token');
      localStorage.removeItem('gmail_refresh_token');
      setGmailStatus((prev) => ({
        ...prev,
        connected: false,
        loading: false,
        error: 'Session expired. Please reconnect to Gmail.',
        lastSync: undefined,
      }));
    }
  };

  const [emails, setEmails] = useState<GmailEmail[]>([]);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [analyses, setAnalyses] = useState<Record<string, EmailAnalysis>>({});
  const [analysisState, setAnalysisState] = useState<Record<string, { loading: boolean; error?: string }>>({});
  const [digestState, setDigestState] = useState<{ mode: 'morning' | 'evening'; loading: boolean; content: string; error: string }>({
    mode: 'morning',
    loading: false,
    content: '',
    error: '',
  });
  const [messageActionState, setMessageActionState] = useState<Record<string, { archiving?: boolean; trashing?: boolean; error?: string }>>({});
  const [replyDrafts, setReplyDrafts] = useState<Record<string, ReplyDraftState>>({});

  const selectedEmail = useMemo(() => emails.find((email) => email.id === selectedEmailId), [emails, selectedEmailId]);
  const analyzedEmails = useMemo(() => emails.filter((email) => Boolean(analyses[email.id])), [emails, analyses]);

  useEffect(() => {
    if (window.google?.accounts?.oauth2) {
      setGisReady(true);
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => setGisReady(true);
    script.onerror = () => {
      setGmailStatus((prev) => ({
        ...prev,
        error: 'Failed to load Google Identity Services. Refresh and try again.',
      }));
    };
    document.head.appendChild(script);
    return () => {
      document.head.removeChild(script);
    };
  }, []);

  const connectGmail = async () => {
    if (!gmailClientId) {
      setGmailStatus((prev) => ({ ...prev, error: 'Enter your Google OAuth Client ID.' }));
      return;
    }

    setGmailStatus((prev) => ({ ...prev, loading: true, error: '' }));

    // Check if running in Tauri desktop app
    const isTauri = typeof window.__TAURI__ !== 'undefined';

    if (isTauri) {
      try {
        // Use desktop client ID for Tauri
        const desktopClientId = GOOGLE_OAUTH_DESKTOP_CLIENT_ID || gmailClientId;

        // Use Tauri's system browser OAuth
        const { invoke } = window.__TAURI__.core;
        const result: any = await invoke('start_oauth_flow', {
          clientId: desktopClientId,
          scopes: `${GMAIL_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
        });

        // Exchange auth code for access token using PKCE + client_secret
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: result.code,
            client_id: desktopClientId,
            client_secret: GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET || '',
            redirect_uri: result.redirect_uri,
            code_verifier: result.code_verifier,
            grant_type: 'authorization_code',
          }),
        });

        const tokenData = await tokenResponse.json();

        if (tokenData.error || !tokenData.access_token) {
          throw new Error(tokenData.error_description || 'Failed to exchange auth code');
        }

        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;
        setGoogleToken(accessToken);

        // Save both access and refresh tokens
        localStorage.setItem('gmail_access_token', accessToken);
        if (refreshToken) {
          localStorage.setItem('gmail_refresh_token', refreshToken);
        }

        // Get user profile
        try {
          const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const profileData = await profileRes.json();
          const profileEmail = profileData?.email || profileData?.name || 'Connected';

          // Save profile to localStorage
          localStorage.setItem('gmail_profile', profileEmail);

          setGmailStatus((prev) => ({
            ...prev,
            loading: false,
            connected: true,
            profile: profileEmail,
            error: '',
          }));
        } catch {
          setGmailStatus((prev) => ({ ...prev, loading: false, connected: true }));
        }

        await fetchEmails(accessToken);
      } catch (error: any) {
        setGmailStatus((prev) => ({
          ...prev,
          loading: false,
          error: error.toString() || 'Desktop OAuth failed',
        }));
      }
      return;
    }

    // Web browser OAuth flow
    if (!gisReady || !window.google?.accounts?.oauth2) {
      setGmailStatus((prev) => ({ ...prev, loading: false, error: 'Google Identity Services are still loading. Try again shortly.' }));
      return;
    }

    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: gmailClientId,
      scope: `${GMAIL_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
      prompt: '',
      callback: async (tokenResponse: any) => {
        if (tokenResponse.error) {
          setGmailStatus((prev) => ({
            ...prev,
            loading: false,
            error: tokenResponse.error_description || tokenResponse.error || 'Gmail authorization failed.',
          }));
          return;
        }

        const accessToken = tokenResponse.access_token as string;
        setGoogleToken(accessToken);

        // Save token to localStorage
        localStorage.setItem('gmail_access_token', accessToken);

        try {
          const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const profileData = await profileRes.json().catch(() => ({}));
          const profileEmail = profileData?.email || profileData?.name || 'Connected';

          // Save profile to localStorage
          localStorage.setItem('gmail_profile', profileEmail);

          setGmailStatus((prev) => ({
            ...prev,
            loading: false,
            connected: true,
            profile: profileEmail,
            error: '',
          }));
        } catch {
          setGmailStatus((prev) => ({ ...prev, loading: false, connected: true }));
        }

        await fetchEmails(accessToken);
      },
    });

    tokenClient.requestAccessToken();
  };

  const fetchEmails = async (accessToken?: string) => {
    const token = accessToken || googleToken;
    if (!token) {
      setGmailStatus((prev) => ({ ...prev, error: 'Connect Gmail first.' }));
      return;
    }

    setGmailStatus((prev) => ({ ...prev, loading: true, error: '' }));

    try {
      const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=15', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!listRes.ok) {
        if (listRes.status === 401) {
          await handle401Error();
          return;
        }
        const errBody = await listRes.json().catch(() => ({}));
        throw new Error(errBody?.error?.message || 'Unable to load inbox.');
      }

      const listData = await listRes.json();
      const messageIds = listData.messages ?? [];
      if (!messageIds.length) {
        setEmails([]);
        setSelectedEmailId(null);
        setGmailStatus((prev) => ({
          ...prev,
          loading: false,
          connected: true,
          lastSync: new Date().toISOString(),
        }));
        return;
      }

      const detailed = await Promise.all(
        messageIds.map(async ({ id }: { id: string }) => {
          const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) {
            throw new Error('Unable to read full message.');
          }
          return res.json();
        }),
      );

      const normalized = detailed.map(normalizeMessage).filter(Boolean) as GmailEmail[];
      setEmails(normalized);
      setSelectedEmailId(normalized[0]?.id ?? null);
      setGmailStatus((prev) => ({
        ...prev,
        loading: false,
        connected: true,
        lastSync: new Date().toISOString(),
        error: '',
      }));
    } catch (error) {
      const message = interpretGmailError(error, 'Unable to read Gmail.');
      setGmailStatus((prev) => ({
        ...prev,
        loading: false,
        error: message,
      }));
    }
  };

  const requireGoogleToken = () => {
    if (!googleToken) {
      throw new Error('Connect Gmail first.');
    }
    return googleToken;
  };

  const handle401Error = async () => {
    // Clear invalid token
    setGoogleToken('');
    localStorage.removeItem('gmail_access_token');

    // Try to refresh if we have a refresh token
    const refreshToken = localStorage.getItem('gmail_refresh_token');
    if (refreshToken) {
      console.log('Attempting to refresh expired token...');
      await refreshAccessToken(refreshToken);
    } else {
      // No refresh token, user must reconnect
      setGmailStatus((prev) => ({
        ...prev,
        connected: false,
        loading: false,
        error: 'Authentication expired. Please reconnect to Gmail.',
        lastSync: undefined,
      }));
    }
  };

  const patchReplyDraft = useCallback((emailId: string, patch: Partial<ReplyDraftState>) => {
    setReplyDrafts((prev) => {
      const existing = prev[emailId] ?? { loading: false, content: '' };
      return {
        ...prev,
        [emailId]: { ...existing, ...patch },
      };
    });
  }, []);

  const interpretGmailError = useCallback(
    (error: unknown, fallback: string) => {
      const message = error instanceof Error ? error.message : fallback;
      if (/insufficient authentication scopes/i.test(message)) {
        const enhancedMessage = 'Missing permissions: Please reconnect Gmail and accept all requested permissions (compose, modify, and send).';
        setGmailStatus((prev) => ({
          ...prev,
          error: enhancedMessage,
          connected: false,
        }));
        return enhancedMessage;
      }
      if (/invalid.*(credential|token|authentication)/i.test(message)) {
        return 'Authentication expired. Please reconnect to Gmail.';
      }
      return message;
    },
    [setGmailStatus],
  );

  const updateMessageAction = useCallback(
    (emailId: string, patch: Partial<{ archiving: boolean; trashing: boolean; error?: string }>) => {
      setMessageActionState((prev) => ({ ...prev, [emailId]: { ...prev[emailId], ...patch } }));
    },
    [],
  );

  const archiveEmail = async (email: GmailEmail) => {
    updateMessageAction(email.id, { archiving: true, error: '' });
    try {
      const token = requireGoogleToken();
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${email.id}/modify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          await handle401Error();
          updateMessageAction(email.id, { archiving: false });
          return;
        }
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error?.message || 'Unable to archive email.');
      }
      updateMessageAction(email.id, { archiving: false });
      await fetchEmails(token);
    } catch (error) {
      const message = interpretGmailError(error, 'Unable to archive email.');
      updateMessageAction(email.id, {
        archiving: false,
        error: message,
      });
    }
  };

  const trashEmail = async (email: GmailEmail) => {
    updateMessageAction(email.id, { trashing: true, error: '' });
    try {
      const token = requireGoogleToken();
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${email.id}/trash`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        if (res.status === 401) {
          await handle401Error();
          updateMessageAction(email.id, { trashing: false });
          return;
        }
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error?.message || 'Unable to delete email.');
      }
      updateMessageAction(email.id, { trashing: false });
      await fetchEmails(token);
    } catch (error) {
      const message = interpretGmailError(error, 'Unable to delete email.');
      updateMessageAction(email.id, {
        trashing: false,
        error: message,
      });
    }
  };

  const generateReplyDraft = async (email: GmailEmail) => {
    if (!openAiKey) {
      patchReplyDraft(email.id, { loading: false, content: '', error: 'Set OPENAI_API_KEY in config.ts.' });
      return;
    }
    patchReplyDraft(email.id, { loading: true, error: '', draftId: undefined, notice: '', dirty: false });
    try {
      const token = requireGoogleToken();
      const promptBody = email.body || email.snippet || 'No body available.';
      const summary = analyses[email.id]?.summary || '';
      const payload = {
        model: 'gpt-4o-mini',
        temperature: 0.35,
        messages: [
          {
            role: 'system',
            content:
              'You are an executive assistant drafting polished, concise email replies. Keep tone warm, confident, and action-oriented. Avoid filler like "I hope this finds you well."',
          },
          {
            role: 'user',
            content: [
              `Original Subject: ${email.subject}`,
              `Sender: ${email.sender}`,
              summary ? `Summary Insight: ${summary}` : null,
              'Full Body:',
              promptBody.slice(0, 4000),
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
      };
      const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openAiKey.trim()}`,
        },
        body: JSON.stringify(payload),
      });
      if (!aiRes.ok) {
        const err = await aiRes.json().catch(() => ({}));
        throw new Error(err?.error?.message || 'Unable to draft reply.');
      }
      const aiData = await aiRes.json();
      const draftText = (extractMessageContent(aiData?.choices?.[0]?.message) || '').trim();
      if (!draftText) {
        throw new Error('Model returned an empty draft.');
      }

      const { recipient, subject: replySubject } = getReplyEnvelope(email);
      const rfc822 = buildReplyMessage({
        to: recipient,
        subject: replySubject,
        body: draftText,
        inReplyTo: email.messageId,
      });
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            raw: rfc822,
            threadId: email.threadId,
          },
        }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          await handle401Error();
          patchReplyDraft(email.id, { loading: false, error: 'Authentication expired' });
          return;
        }
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error?.message || 'Unable to save draft in Gmail.');
      }
      const data = await res.json();
      patchReplyDraft(email.id, {
        loading: false,
        content: draftText,
        draftId: data?.id || data?.message?.id,
        savedAt: new Date().toISOString(),
        error: '',
        notice: 'Draft saved to Gmail.',
        dirty: false,
      });
    } catch (error) {
      const message = interpretGmailError(error, 'Unable to draft reply.');
      patchReplyDraft(email.id, {
        loading: false,
        content: '',
        error: message,
      });
    }
  };

  const handleDraftContentChange = (emailId: string, value: string) => {
    patchReplyDraft(emailId, { content: value, dirty: true, error: '', notice: '' });
  };

  const saveDraftEdits = async (email: GmailEmail) => {
    const draftMeta = replyDrafts[email.id];
    const body = draftMeta?.content?.trim();
    if (!body) {
      patchReplyDraft(email.id, { error: 'Draft is empty. Add text before saving.' });
      return;
    }
    patchReplyDraft(email.id, { saving: true, notice: '' });
    try {
      const token = requireGoogleToken();
      const { recipient, subject: replySubject } = getReplyEnvelope(email);
      const rfc822 = buildReplyMessage({
        to: recipient,
        subject: replySubject,
        body,
        inReplyTo: email.messageId,
      });
      const payload = {
        message: {
          raw: rfc822,
          threadId: email.threadId,
        },
      };
      let res: Response;
      if (draftMeta?.draftId) {
        res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${draftMeta.draftId}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            id: draftMeta.draftId,
            ...payload,
          }),
        });
      } else {
        res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
      }
      if (!res.ok) {
        if (res.status === 401) {
          await handle401Error();
          patchReplyDraft(email.id, { saving: false, error: 'Authentication expired' });
          return;
        }
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error?.message || 'Unable to save draft.');
      }
      const data = await res.json();
      patchReplyDraft(email.id, {
        saving: false,
        dirty: false,
        draftId: data?.id || data?.message?.id,
        savedAt: new Date().toISOString(),
        notice: 'Draft saved to Gmail.',
        error: '',
      });
    } catch (error) {
      const message = interpretGmailError(error, 'Unable to save draft edits.');
      patchReplyDraft(email.id, { saving: false, error: message });
    }
  };

  const sendReply = async (email: GmailEmail) => {
    const draftMeta = replyDrafts[email.id];
    const body = draftMeta?.content?.trim();
    if (!body) {
      patchReplyDraft(email.id, { error: 'Draft is empty. Add text before sending.' });
      return;
    }
    patchReplyDraft(email.id, { sending: true, notice: '' });
    try {
      const token = requireGoogleToken();
      const { recipient, subject: replySubject } = getReplyEnvelope(email);
      const rfc822 = buildReplyMessage({
        to: recipient,
        subject: replySubject,
        body,
        inReplyTo: email.messageId,
      });
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          raw: rfc822,
          threadId: email.threadId,
        }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          await handle401Error();
          patchReplyDraft(email.id, { sending: false, error: 'Authentication expired' });
          return;
        }
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error?.message || 'Unable to send reply.');
      }
      patchReplyDraft(email.id, {
        sending: false,
        dirty: false,
        notice: 'Reply sent!',
        error: '',
      });
      await fetchEmails(token);
    } catch (error) {
      const message = interpretGmailError(error, 'Unable to send reply.');
      patchReplyDraft(email.id, {
        sending: false,
        error: message,
      });
    }
  };


  const runAnalysis = useCallback(
    async (email: GmailEmail, opts: { focus?: boolean } = {}) => {
      if (!openAiKey) {
        setAnalysisState((prev) => ({
          ...prev,
          [email.id]: { loading: false, error: 'Set OPENAI_API_KEY in config.ts.' },
        }));
        return;
      }
      setAnalysisState((prev) => ({ ...prev, [email.id]: { loading: true } }));
      try {
        const payload = {
          model: 'gpt-4o-mini',
          temperature: 0.2,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'email_insights',
              schema: {
                type: 'object',
                required: ['summary', 'category', 'priority', 'action_items', 'deadlines', 'key_points'],
                properties: {
                  summary: { type: 'string' },
                  category: { type: 'string', enum: ['Urgent', 'Action Needed', 'Waiting on Others', 'FYI'] },
                  priority: { type: 'integer', minimum: 1, maximum: 10 },
                  action_items: { type: 'array', items: { type: 'string' } },
                  deadlines: { type: 'array', items: { type: 'string' } },
                  key_points: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
          messages: [
            {
              role: 'system',
              content:
                'You analyze emails for an executive assistant. Provide crisp summaries and structured insights, but never drop enumerated content. If a newsletter or list email (e.g., subjects containing "Things", "Daily", numbered sections, etc.) includes multiple headlines, capture each headline as its own entry in key_points, mirroring the original count (e.g., five items for CNN’s 5 Things). Preserve memorable phrases so downstream readers see every topic.',
            },
            {
              role: 'user',
              content: `Analyze the following email and return structured JSON only.\n\nFrom: ${email.sender}\nSubject: ${
                email.subject
              }\nBody:\n${email.body || email.snippet}`,
            },
          ],
        };

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openAiKey.trim()}`,
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.error?.message || 'OpenAI call failed.');
        }
        const data = await res.json();
        const content = extractMessageContent(data?.choices?.[0]?.message) || '{}';
        const parsed: EmailAnalysis = { ...defaultAnalysis, ...JSON.parse(content) };
        setAnalyses((prev) => ({ ...prev, [email.id]: parsed }));
        setAnalysisState((prev) => ({ ...prev, [email.id]: { loading: false } }));
        if (opts.focus !== false) {
          setSelectedEmailId(email.id);
        }
      } catch (error) {
        setAnalysisState((prev) => ({
          ...prev,
          [email.id]: { loading: false, error: error instanceof Error ? error.message : 'Unable to analyze email.' },
        }));
      }
    },
    [openAiKey],
  );

  useEffect(() => {
    if (!openAiKey || !emails.length) return;
    const nextEmail = emails.find((email) => {
      const state = analysisState[email.id];
      return !analyses[email.id] && !state?.loading;
    });
    if (!nextEmail) return;
    runAnalysis(nextEmail, { focus: false });
  }, [emails, analyses, analysisState, openAiKey, runAnalysis]);

  const generateDigest = async () => {
    if (!emails.length) {
      setDigestState((prev) => ({ ...prev, error: 'Import at least one email first.' }));
      return;
    }
    if (!openAiKey) {
      setDigestState((prev) => ({ ...prev, error: 'Set OPENAI_API_KEY in config.ts.' }));
      return;
    }
    setDigestState((prev) => ({ ...prev, loading: true, error: '', content: '' }));
    try {
      const payload = {
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: 'Compose focused productivity briefings from structured email summaries.',
          },
          {
            role: 'user',
            content: [
              `Create a ${digestState.mode} digest.`,
              digestTemplates[digestState.mode],
              'Emails:',
              JSON.stringify(
                emails.map((email) => ({
                  subject: email.subject,
                  sender: email.sender,
                  snippet: email.snippet,
                  analysis: analyses[email.id] ?? null,
                })),
                null,
                2,
              ),
            ].join('\n\n'),
          },
        ],
      };

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openAiKey.trim()}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || 'Digest generation failed.');
      }
      const data = await res.json();
      const text = extractMessageContent(data?.choices?.[0]?.message) || '';
      setDigestState((prev) => ({ ...prev, loading: false, content: text.trim() || 'No content returned.' }));
    } catch (error) {
      setDigestState((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : 'Unable to generate digest.',
      }));
    }
  };

  const actionBacklog = useMemo(() => {
    return analyzedEmails
      .flatMap((email) => {
        const analysis = analyses[email.id];
        if (!analysis?.action_items?.length) return [];
        return analysis.action_items.map((action) => ({
          emailId: email.id,
          subject: email.subject,
          action,
          category: analysis.category,
          priority: analysis.priority,
        }));
      })
      .sort((a, b) => b.priority - a.priority);
  }, [analyzedEmails, analyses]);

  const deadlineHighlights = useMemo(() => {
    return analyzedEmails
      .flatMap((email) => {
        const analysis = analyses[email.id];
        if (!analysis?.deadlines?.length) return [];
        return analysis.deadlines.map((deadline) => ({
          emailId: email.id,
          subject: email.subject,
          deadline,
          priority: analysis.priority,
        }));
      })
      .slice(0, 5);
  }, [analyzedEmails, analyses]);

  const categoryTallies = useMemo(() => {
    return analyzedEmails.reduce(
      (acc, email) => {
        const category = analyses[email.id]?.category || 'FYI';
        acc[category] = (acc[category] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
  }, [analyzedEmails, analyses]);

  const progressPct = emails.length ? Math.round((analyzedEmails.length / emails.length) * 100) : 0;
  const autoNarrative = !emails.length
    ? 'Import emails to start the AI triage loop.'
    : !openAiKey
      ? 'Set OPENAI_API_KEY in config.ts to enable auto-summaries.'
      : progressPct === 100
        ? 'All emails summarized. Nothing blocking you.'
        : `Auto-reviewing ${emails.length - analyzedEmails.length} emails…`;

  const renderEmailList = () => {
    if (!emails.length) {
      return <p className="text-sm text-slate-500">No emails yet. Connect Gmail and refresh.</p>;
    }

    return emails.map((email) => {
      const insight = analyses[email.id];
      const state = analysisState[email.id];
      return (
        <button
          key={email.id}
          onClick={() => setSelectedEmailId(email.id)}
          className={`w-full rounded-xl border p-4 text-left transition ${
            email.id === selectedEmailId ? 'border-slate-900 bg-slate-50 shadow-sm' : 'border-slate-200 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">{email.subject || '(no subject)'}</p>
              <p className="text-xs text-slate-500">{email.sender}</p>
            </div>
            {insight ? (
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${CATEGORY_COLORS[insight.category]}`}>
                {insight.category}
              </span>
            ) : (
              <span className="text-xs font-medium text-slate-400">Queued</span>
            )}
          </div>
          <p className="mt-2 line-clamp-2 text-xs text-slate-500">{email.snippet || email.body}</p>
          {state?.loading && <p className="mt-2 text-xs text-slate-500">Auto-summarizing…</p>}
          {state?.error && <p className="mt-2 text-xs text-red-500">{state.error}</p>}
        </button>
      );
    });
  };

  
  const renderAnalysisPanel = () => {
    if (!selectedEmail) {
      return <p className="text-sm text-slate-500">Select an email to view details.</p>;
    }
    const insight = analyses[selectedEmail.id];
    const state = analysisState[selectedEmail.id];
    const actionMeta = messageActionState[selectedEmail.id] || {};
    const draftMeta = replyDrafts[selectedEmail.id];

    if (state?.loading) {
      return (
        <div className="space-y-4">
          <div className="animate-pulse space-y-3">
            <div className="h-4 w-1/2 rounded bg-slate-200" />
            <div className="h-3 w-full rounded bg-slate-100" />
            <div className="h-3 w-5/6 rounded bg-slate-100" />
          </div>
          <p className="text-sm text-slate-500">GPT-4o-mini is preparing the summary…</p>
        </div>
      );
    }

    if (!insight) {
      return (
        <div>
          <p className="text-sm text-slate-500">Waiting for analysis… this inbox will auto-populate as soon as GPT finishes.</p>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Subject</p>
          <p className="text-base font-semibold text-slate-900">{selectedEmail.subject || '(no subject)'}</p>
          <p className="text-sm text-slate-500">{selectedEmail.sender}</p>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${CATEGORY_COLORS[insight.category]}`}>
            {insight.category}
          </span>
          <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            Priority {insight.priority}/10
          </span>
        </div>
        <section>
          <p className="text-xs uppercase tracking-wide text-slate-400">Summary</p>
          <p className="mt-1 text-sm text-slate-700">{insight.summary}</p>
        </section>
        <InsightList title="Action Items" items={insight.action_items} empty="No action items detected." />
        <InsightList title="Deadlines" items={insight.deadlines} empty="No deadlines mentioned." />
        <InsightList title="Key Points" items={insight.key_points} empty="No key points extracted." />
        <div className="rounded-2xl border border-slate-100/80 bg-slate-50 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Message Controls</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => archiveEmail(selectedEmail)}
              disabled={actionMeta.archiving || gmailStatus.loading}
              className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {actionMeta.archiving ? 'Archiving…' : 'Archive'}
            </button>
            <button
              type="button"
              onClick={() => trashEmail(selectedEmail)}
              disabled={actionMeta.trashing || gmailStatus.loading}
              className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {actionMeta.trashing ? 'Deleting…' : 'Delete to Trash'}
            </button>
            <button
              type="button"
              onClick={() => generateReplyDraft(selectedEmail)}
              disabled={draftMeta?.loading || gmailStatus.loading || actionMeta.archiving}
              className="rounded-full bg-indigo-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
            >
              {draftMeta?.loading ? 'Drafting…' : 'Auto Reply Draft'}
            </button>
          </div>
          {actionMeta.error && <p className="mt-2 text-xs text-red-500">{actionMeta.error}</p>}
        </div>
        {draftMeta && (
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-wide text-slate-400">AI Reply Draft</p>
              {draftMeta.loading && <span className="text-[10px] uppercase tracking-wide text-slate-400">Generating…</span>}
              {!draftMeta.loading && draftMeta.draftId && (
                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                  Saved {draftMeta.savedAt ? new Date(draftMeta.savedAt).toLocaleTimeString() : 'just now'}
                </span>
              )}
            </div>
            <textarea
              className="mt-3 h-40 w-full rounded-2xl border border-slate-200 bg-white/80 p-3 text-sm text-slate-800 shadow-inner focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              value={draftMeta.content || ''}
              onChange={(evt) => handleDraftContentChange(selectedEmail.id, evt.target.value)}
              disabled={draftMeta.loading}
              placeholder="Generate a reply to start editing…"
            />
            {draftMeta.draftId && (
              <p className="mt-1 text-[10px] text-slate-500">
                Draft ID: <span className="font-mono">{draftMeta.draftId}</span>
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
              <button
                type="button"
                onClick={() => saveDraftEdits(selectedEmail)}
                disabled={draftMeta.saving || draftMeta.loading || !draftMeta.content?.trim()}
                className="rounded-full bg-slate-900 px-4 py-2 text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {draftMeta.saving ? 'Saving…' : draftMeta.dirty ? 'Save Draft' : 'Resave Draft'}
              </button>
              <button
                type="button"
                onClick={() => sendReply(selectedEmail)}
                disabled={draftMeta.sending || draftMeta.loading || !draftMeta.content?.trim()}
                className="rounded-full bg-emerald-600 px-4 py-2 text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-300"
              >
                {draftMeta.sending ? 'Sending…' : 'Send Reply'}
              </button>
            </div>
            {draftMeta.dirty && !draftMeta.loading && (
              <p className="mt-1 text-[10px] text-orange-500">Unsaved edits</p>
            )}
            {draftMeta.notice && <p className="mt-2 text-xs text-emerald-600">{draftMeta.notice}</p>}
            {draftMeta.error && <p className="mt-2 text-xs text-red-500">{draftMeta.error}</p>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 p-4 text-slate-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-500 via-purple-500 to-slate-900 p-6 text-white shadow-2xl">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-white/70">Executive Inbox Radar</p>
              <h1 className="mt-2 text-3xl font-semibold leading-tight sm:text-4xl">Auto-summarized priorities in one sweep</h1>
              <p className="mt-2 max-w-3xl text-sm text-white/80">
                Connect Gmail, paste your OpenAI key, and let GPT-4o-mini triage every thread. Action items, deadlines, and risk levels update the dashboard in real time.
              </p>
            </div>
            <div className="rounded-2xl bg-white/10 p-4 text-sm backdrop-blur">
              <p className="text-white/70">Auto-analysis</p>
              <p className="text-2xl font-semibold">{progressPct}%</p>
              <p className="text-xs text-white/60">{autoNarrative}</p>
            </div>
          </div>
          <div className="mt-6 h-2 w-full rounded-full bg-white/10">
            <div className="h-2 rounded-full bg-white" style={{ width: `${progressPct}%` }} />
          </div>
        </header>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard title="Total Emails" value={emails.length || '—'} hint="Fetched from Gmail inbox" />
          <StatCard title="Analyzed" value={analyzedEmails.length} hint="AI-ready insights" />
          <StatCard title="High Priority" value={categoryTallies['Urgent'] || 0} hint="Marked urgent" emphasis />
          <StatCard title="Action Items" value={actionBacklog.length} hint="Across all emails" />
        </section>

        {/* Only show Gmail Connection section when not connected or there's an error */}
        {(!gmailStatus.connected || gmailStatus.error) && (
          <section className="grid gap-4 lg:grid-cols-2">
            <div className={`rounded-3xl p-5 shadow-inner ${gmailStatus.error ? 'bg-red-900/30 border-2 border-red-500/50' : 'bg-slate-900/50'}`}>
              <h2 className="text-sm font-semibold text-white">Gmail Connection</h2>
              <p className="text-xs text-white/60">
                {typeof window.__TAURI__ !== 'undefined' ? 'Auto-syncing every 5 minutes' : 'Using client ID from config.ts'}
              </p>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={connectGmail}
                  disabled={gmailStatus.loading}
                  className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:bg-white/40"
                >
                  {gmailStatus.loading ? 'Connecting…' : 'Connect Gmail'}
                </button>
              </div>
              {gmailStatus.error && (
                <div className="mt-3 rounded-xl bg-red-500/20 border border-red-400/50 p-3">
                  <p className="text-xs font-semibold text-red-200">{gmailStatus.error}</p>
                  <button
                    type="button"
                    onClick={connectGmail}
                    className="mt-2 rounded-lg bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-900 transition hover:bg-red-200"
                  >
                    Reconnect Gmail
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-3xl bg-white/5 p-5 text-slate-900 shadow-lg lg:col-span-2">
            <div className="flex items-center justify-between text-slate-800">
              <div>
                <h2 className="text-base font-semibold">Inbox Overview</h2>
                <p className="text-xs text-slate-500">Auto-analysis runs the moment emails arrive.</p>
              </div>
              <span className="text-xs text-slate-500">{emails.length} threads</span>
            </div>
            <div className="mt-4 space-y-3">{renderEmailList()}</div>
          </div>
          <div className="rounded-3xl bg-white p-5 shadow-xl">{renderAnalysisPanel()}</div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-3xl bg-white p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">Next Actions</h2>
              <span className="text-xs text-slate-500">{actionBacklog.length} open</span>
            </div>
            <div className="mt-4 space-y-3">
              {actionBacklog.length === 0 && <p className="text-sm text-slate-500">No action items detected yet.</p>}
              {actionBacklog.slice(0, 6).map((item) => (
                <div key={`${item.emailId}-${item.action}`} className="rounded-2xl border border-slate-100 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-900">{item.subject}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${CATEGORY_COLORS[item.category]}`}>{item.category}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-700">{item.action}</p>
                  <p className="text-xs text-slate-400">Priority {item.priority}/10</p>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-3xl bg-white p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">Deadlines Radar</h2>
              <span className="text-xs text-slate-500">{deadlineHighlights.length || 0} flagged</span>
            </div>
            <div className="mt-4 space-y-3">
              {deadlineHighlights.length === 0 && <p className="text-sm text-slate-500">No deadlines extracted yet.</p>}
              {deadlineHighlights.map((deadline) => (
                <div key={`${deadline.emailId}-${deadline.deadline}`} className="rounded-2xl border border-slate-100 p-3">
                  <p className="text-sm font-semibold text-slate-900">{deadline.subject}</p>
                  <p className="text-sm text-slate-700">{deadline.deadline}</p>
                  <p className="text-xs text-slate-400">Priority {deadline.priority}/10</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-3xl bg-white/95 p-5 shadow-2xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">One-click Digest</h2>
              <p className="text-xs text-slate-500">Roll up every summarized email into a briefing.</p>
            </div>
            <div className="flex gap-2 text-sm">
              {(['morning', 'evening'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setDigestState((prev) => ({ ...prev, mode, content: '', error: '' }))}
                  className={`rounded-full px-3 py-1 font-semibold capitalize ${
                    digestState.mode === mode ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-700'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={generateDigest}
            disabled={digestState.loading}
            className="mt-4 w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {digestState.loading ? 'Generating…' : `Generate ${digestState.mode} digest`}
          </button>
          {digestState.error && <p className="mt-2 text-xs text-red-500">{digestState.error}</p>}
          {digestState.content && (
            <pre className="mt-4 whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm text-slate-800">{digestState.content}</pre>
          )}
        </section>
      </div>
    </div>
  );
};

const StatCard: React.FC<{ title: string; value: number | string; hint: string; emphasis?: boolean }> = ({
  title,
  value,
  hint,
  emphasis,
}) => {
  return (
    <div className={`rounded-3xl border border-white/10 p-4 shadow-inner ${emphasis ? 'bg-red-500/10 text-white' : 'bg-slate-900/50 text-white'}`}>
      <p className="text-xs uppercase tracking-wide text-white/70">{title}</p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
      <p className="text-xs text-white/60">{hint}</p>
    </div>
  );
};

const InsightList: React.FC<{ title: string; items: string[]; empty: string }> = ({ title, items, empty }) => {
  if (!items.length) {
    return (
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-400">{title}</p>
        <p className="mt-1 text-sm text-slate-500">{empty}</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-400">{title}</p>
      <ul className="mt-1 space-y-1 text-sm text-slate-700">
        {items.map((item, idx) => (
          <li key={`${title}-${idx}`} className="flex items-start gap-2">
            <span className="text-slate-400">•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const extractMessageContent = (message?: { content?: string | Array<{ type?: string; text?: string }> }) => {
  if (!message?.content) return '';
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        return '';
      })
      .join('\n');
  }
  return '';
};

const decodeBase64Url = (value?: string) => {
  if (!value) return '';
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(normalized);
    return decodeURIComponent(
      decoded
        .split('')
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
  } catch {
    return '';
  }
};

const stripHtml = (html: string) => html.replace(/<\/?[^>]+(>|$)/g, ' ').replace(/\s+/g, ' ').trim();

const extractBodyFromPayload = (payload: any): string => {
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return stripHtml(decodeBase64Url(payload.body.data));
  }
  if (payload.parts?.length) {
    for (const part of payload.parts) {
      const result = extractBodyFromPayload(part);
      if (result) return result;
    }
  }
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  return '';
};

const normalizeMessage = (message: any): GmailEmail | null => {
  if (!message) return null;
  const headerValue = (name: string) => message.payload?.headers?.find((header: any) => header.name === name)?.value || '';
  return {
    id: message.id,
    threadId: message.threadId,
    messageId: headerValue('Message-ID'),
    subject: headerValue('Subject') || '(no subject)',
    sender: headerValue('From') || 'Unknown sender',
    snippet: message.snippet || '',
    body: extractBodyFromPayload(message.payload) || '',
    internalDate: message.internalDate,
  };
};

const getReplyEnvelope = (email: GmailEmail) => {
  const recipient = extractEmailAddress(email.sender);
  if (!recipient) {
    throw new Error('Unable to parse sender email address.');
  }
  const subjectBase = email.subject?.trim() || '(no subject)';
  const subject = subjectBase.toLowerCase().startsWith('re:') ? subjectBase : `Re: ${subjectBase}`;
  return { recipient, subject };
};

const encodeBase64Url = (input: string) => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const buildReplyMessage = ({ to, subject, body, inReplyTo }: { to: string; subject: string; body: string; inReplyTo?: string }) => {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    inReplyTo ? `References: ${inReplyTo}` : null,
    'Content-Type: text/plain; charset="UTF-8"',
  ]
    .filter(Boolean)
    .join('\r\n');
  return encodeBase64Url([headers, '', body].join('\r\n'));
};

const extractEmailAddress = (value: string) => {
  if (!value) return '';
  const angleMatch = value.match(/<([^>]+)>/);
  if (angleMatch?.[1]) {
    return angleMatch[1].trim();
  }
  const trimmed = value.trim();
  if (trimmed.includes(' ')) {
    const emailLike = trimmed.split(/\s+/).find((part) => part.includes('@') && part.includes('.'));
    return emailLike?.replace(/[<>,]/g, '') || '';
  }
  return trimmed;
};

export default EmailProductivityDashboard;
