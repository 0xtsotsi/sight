// Bootstraps the preview bundle. Re-exports React, ReactDOMClient, and
// AgentPanel so the browser can mount the panel without dragging in
// the entire react/renderer type systems.

import React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import AgentPanel from '../AgentPanel.jsx';

export { React, ReactDOMClient, AgentPanel };
export default AgentPanel;
