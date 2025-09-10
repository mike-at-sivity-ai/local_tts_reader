let offscreenDocument = null;
let isRecording = false;
let currentPlayerState = 'stopped';

// NUCLEAR OPTION: Always destroy and recreate offscreen document
async function setupOffscreenDocument() {
  console.log('Setting up fresh offscreen document...');
  
  // First, destroy any existing offscreen document
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    
    if (existingContexts.length > 0) {
      console.log('Destroying existing offscreen document');
      await chrome.offscreen.closeDocument();
      // Wait a bit to ensure it's fully closed
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (e) {
    console.log('No existing offscreen document to close');
  }

  // Always create a fresh offscreen document
  console.log('Creating new offscreen document');
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Playing TTS audio in the background'
  });
  
  // Give it time to initialize
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log('Fresh offscreen document ready');
}

// Set up context menu items
function setupContextMenu() {
  chrome.contextMenus.create({
    id: "readAloud",
    title: "Read Aloud",
    contexts: ["selection", "page"]
  });
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "readAloud") {
    let text = info.selectionText || "";
    
    if (!text) {
      // If no text is selected, get the page content
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: () => {
          return document.body.innerText;
        }
      }).then(results => {
        if (results && results[0] && results[0].result) {
          processAndReadText(results[0].result, tab.id);
        }
      });
    } else {
      // Use the selected text
      processAndReadText(text, tab.id);
    }
  }
});

// Process and read text with default settings
async function processAndReadText(text, tabId) {
  try {
    // Get default settings
    const settings = await chrome.storage.local.get({
      serverUrl: 'http://localhost:8000/v1/audio/speech',
      voice: 'af_bella',
      speed: 1.0,
      recordAudio: false,
      preprocessText: true
    });
    
    // Process text if enabled
    if (settings.preprocessText && tabId) {
      try {
        // Inject the text processor script if needed
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['textProcessor.js']
        });
        
        // Process the text
        const result = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: (textToProcess) => {
            return window.TextProcessor.process(textToProcess);
          },
          args: [text]
        });
        
        if (result && result[0] && result[0].result) {
          text = result[0].result;
        }
      } catch (error) {
        console.error('Error processing text:', error);
        // Fall back to using the original text
      }
    }
    
    // Set state to loading
    currentPlayerState = 'loading';
    chrome.runtime.sendMessage({ 
      type: 'playerStateUpdate', 
      state: 'loading' 
    });
    
    // Start streaming audio
    startStreamingAudio(text, settings);
  } catch (error) {
    console.error('Error in processAndReadText:', error);
    chrome.runtime.sendMessage({ 
      type: 'streamError', 
      error: error.message 
    });
  }
}

// Handle messages from popup or offscreen document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message.type);
  
  switch (message.type) {
    case 'setupOffscreen':
      setupOffscreenDocument().then(() => sendResponse({ success: true }));
      return true;
      
    case 'startStreaming':
      isRecording = message.record;
      // Reset state completely before starting new stream
      currentPlayerState = 'stopped';
      
      // Stop any existing playback first
      chrome.runtime.sendMessage({ type: 'stop' });
      
      // Small delay to ensure clean state
      setTimeout(() => {
        currentPlayerState = 'loading';
        chrome.runtime.sendMessage({ 
          type: 'playerStateUpdate', 
          state: 'loading' 
        });
        startStreamingAudio(message.text, message.settings);
      }, 100);
      
      sendResponse({ success: true });
      return true;
      
    case 'play':
    case 'pause':
    case 'stop':
      // Forward control messages directly to offscreen document
      chrome.runtime.sendMessage(message);
      if (message.type === 'stop') {
        currentPlayerState = 'stopped';
      }
      return true;
      
    case 'stateUpdate':
      currentPlayerState = message.state;
      chrome.runtime.sendMessage({ 
        type: 'playerStateUpdate', 
        state: message.state 
      });
      
      // NUCLEAR: Destroy offscreen document when playback stops
      if (message.state === 'stopped') {
        console.log('Playback stopped, destroying offscreen document');
        setTimeout(async () => {
          try {
            await chrome.offscreen.closeDocument();
            console.log('Offscreen document destroyed');
          } catch (e) {
            console.log('Error closing offscreen document:', e);
          }
        }, 500); // Small delay to ensure final messages are sent
      }
      return true;
      
    case 'audioReady':
      // Audio is ready but not yet playing
      if (currentPlayerState === 'loading') {
        currentPlayerState = 'ready';
        chrome.runtime.sendMessage({ 
          type: 'playerStateUpdate', 
          state: 'ready' 
        });
      }
      return true;
      
    case 'getPlayerState':
      sendResponse({ state: currentPlayerState });
      return true;
      
    case 'seek':
      chrome.runtime.sendMessage({ 
        type: 'seek', 
        time: message.time 
      }, (response) => {
        sendResponse(response);
      });
      return true;
      
    case 'getTimeInfo':
      chrome.runtime.sendMessage({ 
        type: 'getTimeInfo' 
      }, (response) => {
        sendResponse(response);
      });
      return true;
      
    case 'timeUpdate':
      // Forward time updates to the popup
      chrome.runtime.sendMessage(message);
      return true;
      
    case 'streamComplete':
      // NUCLEAR: Destroy offscreen document when stream completes
      console.log('Stream complete, destroying offscreen document');
      setTimeout(async () => {
        try {
          await chrome.offscreen.closeDocument();
          console.log('Offscreen document destroyed after stream complete');
        } catch (e) {
          console.log('Error closing offscreen document:', e);
        }
      }, 500);
      return true;
  }
});

// Start streaming audio from the TTS server
async function startStreamingAudio(text, settings) {
  try {
    // NUCLEAR: Always create fresh offscreen document
    await setupOffscreenDocument();
    
    const response = await fetch(settings.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg, audio/wav, audio/*'
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: settings.voice,
        input: text,
        speed: parseFloat(settings.speed)
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Get the audio data as a blob
    const audioBlob = await response.blob();
    const mimeType = audioBlob.type || 'audio/mpeg';
    
    // Convert blob to array buffer to send to offscreen document
    const arrayBuffer = await audioBlob.arrayBuffer();
    
    // Wait a bit to ensure offscreen is ready
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Send the audio data to the offscreen document
    chrome.runtime.sendMessage({ 
      type: 'processAudioData', 
      audioData: Array.from(new Uint8Array(arrayBuffer)),
      mimeType: mimeType,
      isRecording: isRecording
    });
  } catch (error) {
    console.error('Error streaming audio:', error);
    chrome.runtime.sendMessage({ 
      type: 'streamError', 
      error: error.message 
    });
    
    // Update state to stopped on error
    currentPlayerState = 'stopped';
    chrome.runtime.sendMessage({ 
      type: 'playerStateUpdate', 
      state: 'stopped' 
    });
    
    // NUCLEAR: Clean up on error too
    try {
      await chrome.offscreen.closeDocument();
    } catch (e) {
      // Ignore
    }
  }
}

// Initialize context menu when extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});