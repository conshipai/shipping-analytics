const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const zlib = require('zlib');
const unzipper = require('unzipper');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';  // Important for Docker!

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Storage for CSV data
let shippingData = [];
let dataProcessed = false;

// Ensure uploads directory exists
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    dataLoaded: dataProcessed,
    recordCount: shippingData.length 
  });
});

// Helper: return the path to the current "shipping-data" file if present
function getExistingDataPath() {
  const base = path.resolve('./uploads/shipping-data');
  const candidates = ['.csv', '.gz', '.zip'].map(ext => base + ext);
  return candidates.find(p => fs.existsSync(p)) || null;
}

// Load CSV data from plain CSV, .gz, or .zip
async function loadCSVData(filepath) {
  return new Promise(async (resolve, reject) => {
    const results = [];
    let stream;

    try {
      if (filepath.endsWith('.gz')) {
        // Gzip -> CSV stream
        stream = fs.createReadStream(filepath).pipe(zlib.createGunzip());
      } else if (filepath.endsWith('.zip')) {
        // Zip -> first .csv entry
        const directory = await unzipper.Open.file(filepath);
        const csvFile = directory.files.find(f => f.path.toLowerCase().endsWith('.csv'));
        if (!csvFile) {
          reject(new Error('No CSV file found in ZIP'));
          return;
        }
        stream = csvFile.stream();
      } else {
        // Plain CSV
        stream = fs.createReadStream(filepath);
      }

      stream
        .pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
        .on('data', (data) => {
          // Clean and normalize
          Object.keys(data).forEach(key => {
            if (data[key] === '' || data[key] === 'null') data[key] = null;
          });
          results.push(data);
        })
        .on('end', () => {
          shippingData = results;
          dataProcessed = true;
          console.log(`Loaded ${results.length} records from ${path.basename(filepath)}`);
          resolve(results);
        })
        .on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.csv', '.gz', '.zip'];
    const safeExt = allowed.includes(ext) ? ext : '.csv';
    cb(null, `shipping-data${safeExt}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.csv', '.gz', '.zip'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV, GZ, and ZIP files are allowed'));
    }
  },
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// Check if data exists and load on startup
const existingPath = getExistingDataPath();
if (existingPath) {
  loadCSVData(existingPath).catch(console.error);
}

// API Routes

// Upload CSV / compressed file
app.post('/api/upload', upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file?.path) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    await loadCSVData(req.file.path);
    res.json({ success: true, recordCount: shippingData.length });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search endpoint
app.get('/api/search', (req, res) => {
  if (!dataProcessed) {
    return res.status(400).json({ error: 'No data loaded' });
  }

  const { query, field } = req.query;
  let results = shippingData;

  if (query) {
    results = shippingData.filter(row => {
      if (field && row[field]) {
        return row[field].toLowerCase().includes(query.toLowerCase());
      }
      return Object.values(row).some(val =>
        val && val.toString().toLowerCase().includes(query.toLowerCase())
      );
    });
  }

  res.json({
    results: results.slice(0, 100),
    totalCount: results.length
  });
});

// Top consignees
app.get('/api/analytics/top-consignees', (req, res) => {
  if (!dataProcessed) {
    return res.status(400).json({ error: 'No data loaded' });
  }

  const consigneeCounts = {};
  const consigneeWeights = {};

  shippingData.forEach(row => {
    const consignee = row['Consignee'];
    if (consignee && consignee.trim()) {
      consigneeCounts[consignee] = (consigneeCounts[consignee] || 0) + 1;
      const weight = parseFloat(row['Weight (kg)']) || 0;
      consigneeWeights[consignee] = (consigneeWeights[consignee] || 0) + weight;
    }
  });

  const topConsignees = Object.entries(consigneeCounts)
    .map(([name, count]) => ({
      name,
      shipmentCount: count,
      totalWeight: Math.round(consigneeWeights[name] || 0)
    }))
    .sort((a, b) => b.shipmentCount - a.shipmentCount)
    .slice(0, 20);

  res.json(topConsignees);
});

// Trade lanes
app.get('/api/analytics/trade-lanes', (req, res) => {
  if (!dataProcessed) {
    return res.status(400).json({ error: 'No data loaded' });
  }

  const tradeLanes = {};

  shippingData.forEach(row => {
    const origin = row['Foreign Port of Lading'];
    const destination = row['US Port of Destination'] || row['US Port of Unlading'];

    if (origin && destination) {
      const lane = `${origin} → ${destination}`;
      if (!tradeLanes[lane]) {
        tradeLanes[lane] = {
          count: 0,
          carriers: new Set(),
          weight: 0
        };
      }
      tradeLanes[lane].count++;
      if (row['Carrier Code']) {
        tradeLanes[lane].carriers.add(row['Carrier Code']);
      }
      tradeLanes[lane].weight += parseFloat(row['Weight (kg)']) || 0;
    }
  });

  const topLanes = Object.entries(tradeLanes)
    .map(([lane, data]) => ({
      lane,
      shipmentCount: data.count,
      carrierCount: data.carriers.size,
      totalWeight: Math.round(data.weight),
      carriers: Array.from(data.carriers)
    }))
    .sort((a, b) => b.shipmentCount - a.shipmentCount)
    .slice(0, 20);

  res.json(topLanes);
});

// Carriers
app.get('/api/analytics/carriers', (req, res) => {
  if (!dataProcessed) {
    return res.status(400).json({ error: 'No data loaded' });
  }

  const { lane } = req.query;
  const carrierStats = {};

  shippingData.forEach(row => {
    const carrier = row['Carrier Code'];
    if (!carrier) return;

    if (lane) {
      const origin = row['Foreign Port of Lading'];
      const destination = row['US Port of Destination'] || row['US Port of Unlading'];
      const currentLane = `${origin} → ${destination}`;
      if (currentLane !== lane) return;
    }

    if (!carrierStats[carrier]) {
      carrierStats[carrier] = {
        shipmentCount: 0,
        weight: 0,
        consignees: new Set(),
        lanes: new Set()
      };
    }

    carrierStats[carrier].shipmentCount++;
    carrierStats[carrier].weight += parseFloat(row['Weight (kg)']) || 0;

    if (row['Consignee']) {
      carrierStats[carrier].consignees.add(row['Consignee']);
    }

    const origin = row['Foreign Port of Lading'];
    const destination = row['US Port of Destination'] || row['US Port of Unlading'];
    if (origin && destination) {
      carrierStats[carrier].lanes.add(`${origin} → ${destination}`);
    }
  });

  const topCarriers = Object.entries(carrierStats)
    .map(([code, stats]) => ({
      carrierCode: code,
      shipmentCount: stats.shipmentCount,
      totalWeight: Math.round(stats.weight),
      uniqueConsignees: stats.consignees.size,
      uniqueLanes: stats.lanes.size
    }))
    .sort((a, b) => b.shipmentCount - a.shipmentCount)
    .slice(0, 20);

  res.json(topCarriers);
});

// Commodities
app.get('/api/analytics/commodities', (req, res) => {
  if (!dataProcessed) {
    return res.status(400).json({ error: 'No data loaded' });
  }

  const commodityStats = {};

  shippingData.forEach(row => {
    const commodity = row['Commodity'];
    if (!commodity || !commodity.trim()) return;

    if (!commodityStats[commodity]) {
      commodityStats[commodity] = {
        count: 0,
        weight: 0,
        consignees: new Set(),
        carriers: new Set()
      };
    }

    commodityStats[commodity].count++;
    commodityStats[commodity].weight += parseFloat(row['Weight (kg)']) || 0;

    if (row['Consignee']) {
      commodityStats[commodity].consignees.add(row['Consignee']);
    }
    if (row['Carrier Code']) {
      commodityStats[commodity].carriers.add(row['Carrier Code']);
    }
  });

  const topCommodities = Object.entries(commodityStats)
    .map(([name, stats]) => ({
      commodity: name,
      shipmentCount: stats.count,
      totalWeight: Math.round(stats.weight),
      uniqueConsignees: stats.consignees.size,
      uniqueCarriers: stats.carriers.size
    }))
    .sort((a, b) => b.shipmentCount - a.shipmentCount)
    .slice(0, 20);

  res.json(topCommodities);
});

// Consignee detail
app.get('/api/consignee/:name', (req, res) => {
  if (!dataProcessed) {
    return res.status(400).json({ error: 'No data loaded' });
  }

  const consigneeName = decodeURIComponent(req.params.name);
  const consigneeData = shippingData.filter(row => row['Consignee'] === consigneeName);

  if (consigneeData.length === 0) {
    return res.status(404).json({ error: 'Consignee not found' });
  }

  const stats = {
    name: consigneeName,
    totalShipments: consigneeData.length,
    totalWeight: consigneeData.reduce((sum, row) => sum + (parseFloat(row['Weight (kg)']) || 0), 0),
    carriers: [...new Set(consigneeData.map(r => r['Carrier Code']).filter(Boolean))],
    commodities: [...new Set(consigneeData.map(r => r['Commodity']).filter(Boolean))],
    ports: [...new Set(consigneeData.map(r => r['Foreign Port of Lading']).filter(Boolean))],
    recentShipments: consigneeData.slice(-10).reverse()
  };

  res.json(stats);
});

// Main HTML interface
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Shipping Analytics Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: white; padding: 30px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); margin-bottom: 30px; }
        h1 { color: #333; margin-bottom: 10px; font-size: 2.5em; }
        .subtitle { color: #666; font-size: 1.1em; }
        .upload-section, .search-section { background: white; padding: 20px; border-radius: 10px; margin-bottom: 30px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
        .search-box { display: flex; gap: 10px; margin-bottom: 20px; }
        input[type="text"], select { flex: 1; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 16px; }
        button { padding: 12px 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; transition: transform 0.2s; }
        button:hover { transform: translateY(-2px); }
        .analytics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .analytics-card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
        .analytics-card h3 { color: #333; margin-bottom: 15px; font-size: 1.3em; }
        .stat-item { padding: 10px; border-bottom: 1px solid #e0e0e0; display: flex; justify-content: space-between; align-items: center; transition: background 0.2s; }
        .stat-item:hover { background: #f5f5f5; }
        .stat-item:last-child { border-bottom: none; }
        .stat-label { font-weight: 600; color: #333; }
        .stat-value { color: #667eea; font-weight: 600; }
        .loading { text-align: center; padding: 40px; color: #999; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; }
        .modal-content { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; padding: 30px; border-radius: 15px; max-width: 800px; max-height: 80vh; overflow-y: auto; width: 90%; }
        .close-modal { float: right; font-size: 28px; cursor: pointer; color: #999; }
        .close-modal:hover { color: #333; }
        .clickable { cursor: pointer; text-decoration: underline; }
        .clickable:hover { color: #764ba2; }
        #searchResults { max-height: 400px; overflow-y: auto; }
        .result-item { padding: 15px; border-bottom: 1px solid #e0e0e0; background: #f9f9f9; margin-bottom: 10px; border-radius: 8px; }
        .badge { display: inline-block; padding: 4px 8px; background: #667eea; color: white; border-radius: 4px; font-size: 12px; margin-right: 5px; }
        .info-note { background: #f0f8ff; border-left: 4px solid #667eea; padding: 10px; margin: 10px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚢 Shipping Analytics Dashboard</h1>
            <div class="subtitle">Analyze shipping data to identify sales opportunities</div>
        </div>

        <div class="upload-section">
            <h3>Upload CSV Data</h3>
            <div class="info-note">Accepts .csv, .gz (gzipped CSV), or .zip files up to 100MB</div>
            <input type="file" id="csvFile" accept=".csv,.gz,.zip">
            <button onclick="uploadCSV()">Upload & Process</button>
            <span id="uploadStatus"></span>
        </div>

        <div class="search-section">
            <h3>Search Records</h3>
            <div class="search-box">
                <input type="text" id="searchQuery" placeholder="Search consignees, commodities, ports...">
                <select id="searchField">
                    <option value="">All Fields</option>
                    <option value="Consignee">Consignee</option>
                    <option value="Commodity">Commodity</option>
                    <option value="Carrier Code">Carrier</option>
                    <option value="Foreign Port of Lading">Origin Port</option>
                    <option value="US Port of Destination">Destination Port</option>
                </select>
                <button onclick="searchRecords()">Search</button>
            </div>
            <div id="searchResults"></div>
        </div>

        <div class="analytics-grid">
            <div class="analytics-card">
                <h3>📊 Top Consignees</h3>
                <div id="topConsignees" class="loading">Loading...</div>
            </div>

            <div class="analytics-card">
                <h3>🛤️ Top Trade Lanes</h3>
                <div id="topLanes" class="loading">Loading...</div>
            </div>

            <div class="analytics-card">
                <h3>🚢 Top Carriers</h3>
                <div id="topCarriers" class="loading">Loading...</div>
            </div>

            <div class="analytics-card">
                <h3>📦 Top Commodities</h3>
                <div id="topCommodities" class="loading">Loading...</div>
            </div>
        </div>
    </div>

    <div id="detailModal" class="modal">
        <div class="modal-content">
            <span class="close-modal" onclick="closeModal()">&times;</span>
            <div id="modalContent"></div>
        </div>
    </div>

    <script>
        async function uploadCSV() {
            const fileInput = document.getElementById('csvFile');
            const file = fileInput.files[0];
            if (!file) {
                alert('Please select a file (.csv, .gz, or .zip)');
                return;
            }

            const formData = new FormData();
            formData.append('csvFile', file);

            const statusEl = document.getElementById('uploadStatus');
            statusEl.textContent = 'Uploading and processing...';

            try {
                const response = await fetch('/api/upload', {
                    method: 'POST',
                    body: formData
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Upload failed');
                statusEl.textContent = \`Successfully loaded \${result.recordCount} records\`;
                loadAnalytics();
            } catch (error) {
                statusEl.textContent = 'Error: ' + error.message;
            }
        }

        async function searchRecords() {
            const query = document.getElementById('searchQuery').value;
            const field = document.getElementById('searchField').value;

            const response = await fetch(\`/api/search?query=\${encodeURIComponent(query)}&field=\${field}\`);
            const data = await response.json();

            const resultsDiv = document.getElementById('searchResults');
            if (data.results && data.results.length > 0) {
                resultsDiv.innerHTML = \`
                    <p>Found \${data.totalCount} results (showing first 100)</p>
                    \${data.results.map(r => \`
                        <div class="result-item">
                            <strong>Consignee:</strong> \${r['Consignee'] || 'N/A'}<br>
                            <strong>Commodity:</strong> \${r['Commodity'] || 'N/A'}<br>
                            <strong>Carrier:</strong> \${r['Carrier Code'] || 'N/A'}<br>
                            <strong>Route:</strong> \${r['Foreign Port of Lading'] || 'N/A'} → \${r['US Port of Destination'] || r['US Port of Unlading'] || 'N/A'}<br>
                            <strong>Weight:</strong> \${r['Weight (kg)'] || 'N/A'} kg
                        </div>
                    \`).join('')}
                \`;
            } else {
                resultsDiv.innerHTML = '<p>No results found</p>';
            }
        }

        async function loadAnalytics() {
            // Load top consignees
            fetch('/api/analytics/top-consignees')
                .then(r => r.json())
                .then(data => {
                    const html = data.map(c => \`
                        <div class="stat-item">
                            <span class="stat-label clickable" onclick="showConsigneeDetail('\${encodeURIComponent(c.name)}')">\${c.name}</span>
                            <span class="stat-value">\${c.shipmentCount} shipments</span>
                        </div>
                    \`).join('');
                    document.getElementById('topConsignees').innerHTML = html;
                })
                .catch(() => {
                    document.getElementById('topConsignees').innerHTML = 'No data available';
                });

            // Load trade lanes
            fetch('/api/analytics/trade-lanes')
                .then(r => r.json())
                .then(data => {
                    const html = data.map(l => \`
                        <div class="stat-item">
                            <span class="stat-label">\${l.lane}</span>
                            <span class="stat-value">\${l.shipmentCount} shipments</span>
                        </div>
                    \`).join('');
                    document.getElementById('topLanes').innerHTML = html;
                })
                .catch(() => {
                    document.getElementById('topLanes').innerHTML = 'No data available';
                });

            // Load carriers
            fetch('/api/analytics/carriers')
                .then(r => r.json())
                .then(data => {
                    const html = data.map(c => \`
                        <div class="stat-item">
                            <span class="stat-label">\${c.carrierCode}</span>
                            <span class="stat-value">\${c.shipmentCount} shipments</span>
                        </div>
                    \`).join('');
                    document.getElementById('topCarriers').innerHTML = html;
                })
                .catch(() => {
                    document.getElementById('topCarriers').innerHTML = 'No data available';
                });

            // Load commodities
            fetch('/api/analytics/commodities')
                .then(r => r.json())
                .then(data => {
                    const html = data.map(c => \`
                        <div class="stat-item">
                            <span class="stat-label">\${c.commodity.substring(0, 40)}\${c.commodity.length > 40 ? '...' : ''}</span>
                            <span class="stat-value">\${c.shipmentCount} shipments</span>
                        </div>
                    \`).join('');
                    document.getElementById('topCommodities').innerHTML = html;
                })
                .catch(() => {
                    document.getElementById('topCommodities').innerHTML = 'No data available';
                });
        }

        async function showConsigneeDetail(consigneeName) {
            const response = await fetch(\`/api/consignee/\${consigneeName}\`);
            const data = await response.json();

            const modalContent = document.getElementById('modalContent');
            modalContent.innerHTML = \`
                <h2>\${data.name}</h2>
                <div style="margin: 20px 0;">
                    <p><strong>Total Shipments:</strong> \${data.totalShipments}</p>
                    <p><strong>Total Weight:</strong> \${Math.round(data.totalWeight).toLocaleString()} kg</p>
                </div>
                <div style="margin: 20px 0;">
                    <h3>Carriers Used:</h3>
                    \${data.carriers.map(c => \`<span class="badge">\${c}</span>\`).join('')}
                </div>
                <div style="margin: 20px 0;">
                    <h3>Commodities:</h3>
                    \${data.commodities.slice(0, 10).map(c => \`<div style="padding: 5px;">\${c}</div>\`).join('')}
                </div>
                <div style="margin: 20px 0;">
                    <h3>Origin Ports:</h3>
                    \${data.ports.slice(0, 10).map(p => \`<span class="badge">\${p}</span>\`).join('')}
                </div>
            \`;

            document.getElementById('detailModal').style.display = 'block';
        }

        function closeModal() {
            document.getElementById('detailModal').style.display = 'none';
        }

        // Load analytics on page load
        loadAnalytics();

        // Allow Enter key to search
        document.getElementById('searchQuery').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') searchRecords();
        });
    </script>
</body>
</html>
  `);
});

// FIXED: Listen on 0.0.0.0 for Docker
app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Health check available at http://${HOST}:${PORT}/health`);
  if (dataProcessed) {
    console.log(`Data loaded: ${shippingData.length} records`);
  }
});
