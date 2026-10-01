# Operator Guidance Messages

Catalogue of contextual messages the kiosk could show to help the machine operator (Bohrmeister) during drilling and grouting. These replace the old pop-up warnings that shifted the UI and need expert review before implementation.

**Design constraint**: messages must have a dedicated, fixed-size area in the UI — they must never push other content around.

## During Bohren

### Rohrwechsel in progress
- **Trigger**: Klemmbacke opens (clamp pressure drops below threshold)
- **Message**: "Rohrwechsel — Messwerte werden nicht aufgezeichnet."
- **Purpose**: Confirm the kiosk detected the pipe change and paused recording
- **Priority**: High — operator needs to know data is paused

### Rohrwechsel complete
- **Trigger**: Klemmbacke closes again after a Rohrwechsel
- **Message**: "Rohr {n} eingebaut — Aufzeichnung läuft."
- **Purpose**: Confirm recording resumed after pipe insertion
- **Priority**: High

### Unexpected clamp opening (short)
- **Trigger**: Clamp opens for < configured minimum duration, then closes
- **Message**: "Kurze Klemmbewegung erkannt — kein Rohrwechsel registriert."
- **Purpose**: Prevent confusion when the clamp sensor briefly triggers without an actual pipe change
- **Priority**: Medium

### Clamp threshold possibly misconfigured
- **Trigger**: Clamp never triggers during an entire session, or triggers at unexpected intervals
- **Message**: "Klemmbacke hat {seit X Minuten / noch nie} ausgelöst. Schwellenwerte prüfen?"
- **Purpose**: Nudge service personnel to check configuration without alarming the operator
- **Priority**: Low — should be subtle, not a red warning

### Depth sensor gap
- **Trigger**: Depth sensor stops updating for > N seconds while recording is active
- **Message**: "Tiefensensor sendet seit {n} Sekunden keine Daten."
- **Purpose**: Alert to a potential connection issue before data loss accumulates
- **Priority**: Medium

## During Verpressen

### Mode not set
- **Trigger**: Recording is active but operating mode is still "bohren" while pressure/flow sensors suggest grouting has started
- **Message**: "Verpressen erkannt — Modus wechseln?"
- **Purpose**: Prevent data being recorded under the wrong mode
- **Priority**: Medium

### Suspension pressure approaching limit
- **Trigger**: Druck Medium exceeds Soll by > 25%
- **Message**: "Suspensionsdruck über Sollwert."
- **Purpose**: Early warning for pressure exceedance
- **Priority**: High — safety relevant

### Volume target reached
- **Trigger**: Q_verpressen reaches the Soll volume from the Schichtauftrag
- **Message**: "Sollvolumen erreicht: {value} l"
- **Purpose**: Inform operator the target has been met
- **Priority**: Medium

## General (all modes)

### No MQTT data
- **Trigger**: No readings received for > 30 seconds while a session is active
- **Message**: "Keine Messdaten seit {n} Sekunden. Verbindung prüfen."
- **Purpose**: Catch disconnections before they cause significant data loss
- **Priority**: High

### Upload failed
- **Trigger**: Session upload to Implenia API fails
- **Message**: "Hochladen fehlgeschlagen — Daten sind lokal gesichert. Erneut versuchen oder exportieren."
- **Purpose**: Reassure operator that data is safe and offer recovery paths
- **Priority**: High

### Session has no readings
- **Trigger**: Operator stops a recording that captured zero readings
- **Message**: "Keine Messwerte aufgezeichnet. Sensorzuordnung prüfen."
- **Purpose**: Flag that the recording was empty, likely a configuration issue
- **Priority**: Medium

## Open questions for expert review

- Which of these messages are actually useful in practice? The Bohrmeister may already know most of this from the machine itself.
- Should messages auto-dismiss, or persist until tapped away?
- What is the right visual treatment — toast-style, status bar, or inline in the gauge area?
- Are there machine-specific conditions (e.g. DSV vs. Ankerbohren) that need different messages?
- Should any of these trigger a voice announcement for hands-free operation?
