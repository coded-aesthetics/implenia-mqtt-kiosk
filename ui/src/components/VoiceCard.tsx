import { useState } from 'react';
import { configStyles as styles } from './configStyles';

/**
 * Voice control, opt-in.
 *
 * Experimental per CLAUDE.md: workers' hands are usually occupied or gloved,
 * so this is being tried on site rather than assumed to help. Off until
 * switched on — the Vosk engine is only loaded once it is.
 *
 * Both settings live in localStorage and are announced with a window event,
 * because the listeners that act on them sit outside this tree.
 */
export function VoiceCard() {
  const [voiceEnabled, setVoiceEnabled] = useState(
    () => localStorage.getItem('voiceEnabled') === 'true', // opt-in: off until explicitly enabled
  );

  function toggleVoice() {
    const next = !voiceEnabled;
    setVoiceEnabled(next);
    localStorage.setItem('voiceEnabled', String(next));
    window.dispatchEvent(new Event('voiceEnabledChanged'));
    // Auto-disable wake word if voice is disabled
    if (!next && magicWord) {
      toggleMagicWord();
    }
  }

  // Magic word setting
  const [magicWord, setMagicWord] = useState(
    () => localStorage.getItem('magicWordEnabled') === 'true',
  );

  function toggleMagicWord() {
    const next = !magicWord;
    setMagicWord(next);
    localStorage.setItem('magicWordEnabled', String(next));
    window.dispatchEvent(new Event('magicWordChanged'));
  }

  return (
    <div style={styles.card}>
      <div style={styles.statusRow}>
        <span style={styles.label}>Sprachsteuerung (experimentell)</span>
      </div>
      <button
        onClick={toggleVoice}
        style={{
          ...styles.toggleButton,
          backgroundColor: voiceEnabled ? '#1b5e20' : '#2a2a4a',
        }}
      >
        <span style={{
          ...styles.toggleKnob,
          transform: voiceEnabled ? 'translateX(32px)' : 'translateX(0)',
        }} />
      </button>
      <div style={styles.toggleLabel}>
        {voiceEnabled ? 'Aktiviert' : 'Deaktiviert'}
      </div>
      <div style={styles.envHint}>
        Mikrofon-Taste für Push-to-Talk oder Aktivwort-Modus.
      </div>

      {/* Wake word sub-setting (only shown when voice is enabled) */}
      {voiceEnabled && (
        <div style={{ marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid #2a3f5f' }}>
          <div style={styles.statusRow}>
            <span style={{ ...styles.label, fontSize: '1rem' }}>Aktivwort-Modus</span>
          </div>
          <button
            onClick={toggleMagicWord}
            style={{
              ...styles.toggleButton,
              backgroundColor: magicWord ? '#1b5e20' : '#2a2a4a',
            }}
          >
            <span style={{
              ...styles.toggleKnob,
              transform: magicWord ? 'translateX(32px)' : 'translateX(0)',
            }} />
          </button>
          <div style={styles.toggleLabel}>
            {magicWord ? 'Aktiviert' : 'Deaktiviert'}
          </div>
          <div style={styles.envHint}>
            Sagen Sie &quot;Computer&quot; gefolgt von einem Befehl. Das Mikrofon bleibt dauerhaft aktiv.
          </div>
        </div>
      )}
    </div>
  );
}
