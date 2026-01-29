
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const { db } = require('./database');

// STORE MULTIPLE STREAMS: Map<streamId, { command, inputStream, loopActive, userId }>
const activeStreams = new Map();

const startStream = (inputPaths, destinations, options = {}) => {
  if (!destinations || destinations.length === 0) {
      throw new Error("Pilih minimal satu tujuan streaming.");
  }

  const streamId = 'stream_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const files = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  const isAllAudio = files.every(f => f.toLowerCase().endsWith('.mp3'));
  const shouldLoop = !!options.loop;
  const currentUserId = options.userId;
  
  // State object for this specific stream
  const streamState = {
      id: streamId,
      userId: currentUserId,
      loopActive: true,
      activeInputStream: null,
      command: null,
      destinations: destinations // Store info for status check
  };

  return new Promise((resolve, reject) => {
    let command = ffmpeg();
    let lastProcessedSecond = 0;

    if (isAllAudio) {
      const mixedStream = new PassThrough();
      streamState.activeInputStream = mixedStream;
      let fileIndex = 0;

      const playNextSong = () => {
        if (!streamState.loopActive) return;
        const currentFile = files[fileIndex];
        const songStream = fs.createReadStream(currentFile);
        
        songStream.pipe(mixedStream, { end: false });

        songStream.on('end', () => {
           fileIndex++;
           if (fileIndex >= files.length) {
             if (shouldLoop) {
               fileIndex = 0; 
               playNextSong(); 
             } else {
               mixedStream.end();
             }
           } else {
             playNextSong();
           }
        });
        
        songStream.on('error', (err) => {
           console.error(`Error playing file ${currentFile}:`, err);
           fileIndex++; // Skip broken file
           if(fileIndex < files.length) playNextSong();
        });
      };

      playNextSong();

      const videoFilter = [
        'scale=1280:720:force_original_aspect_ratio=decrease',
        'pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black',
        'format=yuv420p'
      ].join(',');

      let imageInput = options.coverImagePath;
      if (!imageInput || !fs.existsSync(imageInput)) {
        command.input('color=c=black:s=1280x720:r=24').inputOptions(['-f lavfi', '-re']);
      } else {
        command.input(imageInput).inputOptions(['-loop 1', '-framerate 2', '-re']); 
      }

      command.input(mixedStream).inputFormat('mp3').inputOptions(['-re']); 
      
      const encodingFlags = [
        '-map 0:v', '-map 1:a', `-vf ${videoFilter}`,
        '-c:v libx264', '-preset ultrafast', '-r 24', '-g 48', '-keyint_min 48', '-sc_threshold 0',
        '-b:v 3000k', '-minrate 3000k', '-maxrate 3000k', '-bufsize 6000k', '-nal-hrd cbr',
        '-c:a aac', '-b:a 128k', '-ar 44100', '-af aresample=async=1',
        '-f flv', '-flvflags no_duration_filesize'
      ];

      destinations.forEach(dest => {
          const fullUrl = dest.rtmp_url + dest.stream_key;
          command.output(fullUrl).outputOptions(encodingFlags);
      });

    } else {
      // Playlist Video Logic
      const playlistPath = path.join(__dirname, 'uploads', `playlist_${streamId}.txt`);
      const playlistContent = files.map(f => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join('\n');
      fs.writeFileSync(playlistPath, playlistContent);

      const videoInputOpts = ['-f', 'concat', '-safe', '0', '-re'];
      if (shouldLoop) videoInputOpts.unshift('-stream_loop', '-1');

      command.input(playlistPath).inputOptions(videoInputOpts);
      
      const copyFlags = ['-c copy', '-f flv', '-flvflags no_duration_filesize'];
      destinations.forEach(dest => {
          const fullUrl = dest.rtmp_url + dest.stream_key;
          command.output(fullUrl).outputOptions(copyFlags);
      });
      
      // Cleanup playlist file on exit
      streamState.cleanupFile = playlistPath;
    }

    streamState.command = command
      .on('start', (commandLine) => {
        const destNames = destinations.map(d => d.name || d.platform).join(', ');
        if (global.io) global.io.emit('log', { type: 'start', message: `Started Stream [${streamId}] to: ${destNames}` });
        
        // Save to MAP
        activeStreams.set(streamId, streamState);
        resolve(streamId);
      })
      .on('progress', (progress) => {
        const currentTimemark = progress.timemark; 
        const parts = currentTimemark.split(':');
        const totalSeconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parseFloat(parts[2]));
        const diff = Math.floor(totalSeconds - lastProcessedSecond);

        if (diff >= 5) { 
            lastProcessedSecond = totalSeconds;
            
            // Usage Tracking (shared across all streams of user)
            db.get(`
                SELECT u.usage_seconds, p.daily_limit_hours 
                FROM users u JOIN plans p ON u.plan_id = p.id 
                WHERE u.id = ?`, [currentUserId], (err, row) => {
                if (row) {
                    const newUsage = row.usage_seconds + diff;
                    const limitSeconds = row.daily_limit_hours * 3600;

                    db.run("UPDATE users SET usage_seconds = ? WHERE id = ?", [newUsage, currentUserId]);

                    if (newUsage >= limitSeconds) {
                        if (global.io) global.io.emit('log', { type: 'error', message: 'Quota exhausted. Stopping all streams.' });
                        stopStream(null, currentUserId); // Stop all streams for this user
                    }

                    if (global.io) {
                        global.io.emit('stats', { 
                            streamId: streamId, // Critical for frontend mapping
                            duration: progress.timemark, 
                            bitrate: progress.currentKbps ? Math.round(progress.currentKbps) + ' kbps' : 'N/A',
                            usage_remaining: Math.max(0, limitSeconds - newUsage)
                        });
                    }
                }
            });
        }
      })
      .on('error', (err) => {
        if (err.message.includes('SIGKILL')) return;
        if (global.io) global.io.emit('log', { type: 'error', message: `Stream [${streamId}] Error: ` + err.message });
        stopStream(streamId);
      })
      .on('end', () => {
        if (global.io) global.io.emit('log', { type: 'end', message: `Stream [${streamId}] finished.` });
        stopStream(streamId);
      });

    streamState.command.run();
  });
};

const stopStream = (streamId = null, userId = null) => {
  let stoppedCount = 0;

  activeStreams.forEach((state, key) => {
      // Logic: Stop if ID matches OR if User matches (stop all for user) OR if stop ALL (no args)
      if ((streamId && key === streamId) || (userId && state.userId === userId) || (!streamId && !userId)) {
          
          state.loopActive = false;
          if (state.activeInputStream) {
              try { state.activeInputStream.end(); } catch(e) {}
          }
          if (state.command) {
              try { state.command.kill('SIGKILL'); } catch (e) {}
          }
          if (state.cleanupFile && fs.existsSync(state.cleanupFile)) {
              try { fs.unlinkSync(state.cleanupFile); } catch(e) {}
          }
          
          activeStreams.delete(key);
          stoppedCount++;
      }
  });

  return stoppedCount > 0;
};

// Return array of active stream info for UI
const getActiveStreams = (userId) => {
    const list = [];
    activeStreams.forEach((state, id) => {
        if (state.userId === userId) {
            list.push({
                id: state.id,
                destinations: state.destinations.map(d => ({ 
                    name: d.name, 
                    platform: d.platform,
                    rtmp_url: d.rtmp_url // Optional, for debug
                }))
            });
        }
    });
    return list;
};

module.exports = { startStream, stopStream, getActiveStreams };
