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
const HOST = '0.0.0.0';

// Middleware
app.use(cors());
app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.url;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  
  // Log to console (will appear in Coolify logs)
  console.log(`[${timestamp}] IP: ${ip} - ${method} ${url} - Agent: ${userAgent}`);
  
  // Optional: Write to a file
  const logEntry = `${timestamp},${ip},${method},${url},"${userAgent}"\n`;
  fs.appendFile('./uploads/access.log', logEntry, (err) => {
    if (err) console.error('Error writing to log file:', err);
  });
  
  next();
});
app.use(express.json());
app.use(express.static('public'));

// Storage for CSV data
let shippingData = [];
let dataProcessed = false;
let consigneeIndex = {}; // For faster consignee lookups

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

// Build consignee index for faster lookups
function buildConsigneeIndex() {
  consigneeIndex = {};
  
  shippingData.forEach(row => {
    const consignee = row['Consignee'];
    if (consignee && consignee.trim()) {
      if (!consigneeIndex[consignee]) {
        consigneeIndex[consignee] = {
          name: consignee,
          shipments: [],
          totalWeight: 0,
          carriers: new Set(),
          commodities: new Set(),
          ports: new Set(),
          firstShipment: null,
          lastShipment: null
        };
      }
      
      consigneeIndex[consignee].shipments.push(row);
      consigneeIndex[consignee].totalWeight += parseFloat(row['Weight (kg)']) || 0;
      
      if (row['Carrier Code']) consigneeIndex[consignee].carriers.add(row['Carrier Code']);
      if (row['Commodity']) consigneeIndex[consignee].commodities.add(row['Commodity']);
      if (row['Foreign Port of Lading']) consigneeIndex[consignee].ports.add(row['Foreign Port of Lading']);
      
      // Track dates if available
      if (row['Arrival Date']) {
        const date = new Date(row['Arrival Date']);
        if (!consigneeIndex[consignee].firstShipment || date < consigneeIndex[consignee].firstShipment) {
          consigneeIndex[consignee].firstShipment = date;
        }
        if (!consigneeIndex[consignee].lastShipment || date > consigneeIndex[consignee].lastShipment) {
          consigneeIndex[consignee].lastShipment = date;
        }
      }
    }
  });
  
  console.log(`Built index for ${Object.keys(consigneeIndex).length} consignees`);
}

// Load CSV data from plain CSV, .gz, or .zip
async function loadCSVData(filepath) {
  return new Promise(async (resolve, reject) => {
    const results = [];
    let stream;

    try {
      if (filepath.endsWith('.gz')) {
        stream = fs.createReadStream(filepath).pipe(zlib.createGunzip());
      } else if (filepath.endsWith('.zip')) {
        const directory = await unzipper.Open.file(filepath);
        const csvFile = directory.files.find(f => f.path.toLowerCase().endsWith('.csv'));
        if (!csvFile) {
          reject(new Error('No CSV file found in ZIP'));
          return;
        }
        stream = csvFile.stream();
      } else {
        stream = fs.createReadStream(filepath);
      }

      stream
        .pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
        .on('data', (data) => {
          Object.keys(data).forEach(key => {
            if (data[key] === '' || data[key] === 'null') data[key] = null;
          });
          results.push(data);
        })
        .on('end', () => {
          shippingData = results;
          dataProcessed = true;
          buildConsigneeIndex(); // Build index after loading
          console.log(`Loaded ${results.length} records from ${path.basename(filepath)}`);
          resolve(results);
        })
        .on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

// Multer configuration
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
    fileSize: 100 * 1024 * 1024
  }
});

// Load existing data on startup
const existingPath = getExistingDataPath();
if (existingPath) {
  loadCSVData(existingPath).catch(console.error);
}

// API ROUTES

// Upload CSV
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

// NEW: Get all consignees with filtering and pagination
app.get('/api/consignees/all', (req, res) => {
  if (!dataProcessed) {
    return res.status(400).json({ error: 'No data loaded' });
  }

  const {
    page = 1,
    limit = 50,
    sortBy = 'shipmentCount', // shipmentCount, name, weight, recent
    order = 'desc',
    minShipments = 0,
    search = '',
    commodity = '',
    port = '',
    carrier = ''
  } = req.query;

  // Get all consignees as array
  let consignees = Object.values(consigneeIndex).map(c => ({
    name: c.name,
    shipmentCount: c.shipments.length,
    totalWeight: Math.round(c.totalWeight),
    carrierCount: c.carriers.size,
    commodityCount: c.commodities.size,
    portCount: c.ports.size,
    carriers: Array.from(c.carriers),
    commodities: Array.from(c.commodities),
    ports: Array.from(c.ports),
    lastActivity: c.lastShipment
  }));

  // Apply filters
  if (search) {
    const searchLower = search.toLowerCase();
    consignees = consignees.filter(c => 
      c.name.toLowerCase().includes(searchLower)
    );
  }

  if (minShipments > 0) {
    consignees = consignees.filter(c => c.shipmentCount >= parseInt(minShipments));
  }

  if (commodity) {
    consignees = consignees.filter(c => 
      c.commodities.some(com => com.toLowerCase().includes(commodity.toLowerCase()))
    );
  }

  if (port) {
    consignees = consignees.filter(c => 
      c.ports.some(p => p.toLowerCase().includes(port.toLowerCase()))
    );
  }

  if (carrier) {
    consignees = consignees.filter(c => 
      c.carriers.some(car => car.toLowerCase().includes(carrier.toLowerCase()))
    );
  }

  // Sort
  consignees.sort((a, b) => {
    let comparison = 0;
    switch (sortBy) {
      case 'name':
        comparison = a.name.localeCompare(b.name);
        break;
      case 'weight':
        comparison = a.totalWeight - b.totalWeight;
        break;
      case 'recent':
        comparison = (a.lastActivity || 0) - (b.lastActivity || 0);
        break;
      default: // shipmentCount
        comparison = a.shipmentCount - b.shipmentCount;
    }
    return order === 'desc' ? -comparison : comparison;
  });

  // Paginate
  const startIndex = (page - 1) * limit;
  const endIndex = startIndex + parseInt(limit);
  const paginatedConsignees = consignees.slice(startIndex, endIndex);

  res.json({
    consignees: paginatedConsignees,
    totalCount: consignees.length,
    page: parseInt(page),
    totalPages: Math.ceil(consignees.length / limit),
    hasMore: endIndex < consignees.length
  });
});

// NEW: Search consignees with autocomplete
app.get('/api/consignees/search', (req, res) => {
  if (!dataProcessed) {
    return res.status(400).json({ error: 'No data loaded' });
  }

  const { q = '', limit = 10 } = req.query;
  
  if (!q || q.length < 2) {
    return res.json({ suggestions: [] });
  }

  const searchLower = q.toLowerCase();
  const suggestions = Object.keys(consigneeIndex)
    .filter(name => name.toLowerCase().includes(searchLower))
    .slice(0, limit)
    .map(name => ({
      name,
      shipmentCount: consigneeIndex[name].shipments.length
    }));

  res.json({ suggestions });
});

// NEW: Export consignees to CSV
app.get('/api/consignees/export', (req, res) => {
  if (!dataProcessed) {
    return res.status(400).json({ error: 'No data loaded' });
  }

  const consignees = Object.values(consigneeIndex).map(c => ({
    Name: c.name,
    'Total Shipments': c.shipments.length,
    'Total Weight (kg)': Math.round(c.totalWeight),
    'Unique Carriers': c.carriers.size,
    'Unique Commodities': c.commodities.size,
    'Origin Ports': Array.from(c.ports).join('; '),
    'Top Commodities': Array.from(c.commodities).slice(0, 5).join('; '),
    'Carriers Used': Array.from(c.carriers).join('; ')
  }));

  // Sort by shipment count
  consignees.sort((a, b) => b['Total Shipments'] - a['Total Shipments']);

  // Convert to CSV
  const headers = Object.keys(consignees[0]);
  const csvContent = [
    headers.join(','),
    ...consignees.map(row => 
      headers.map(header => {
        const value = row[header];
        // Escape quotes and wrap in quotes if contains comma
        const escaped = String(value).replace(/"/g, '""');
        return escaped.includes(',') ? `"${escaped}"` : escaped;
      }).join(',')
    )
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=consignees_export.csv');
  res.send(csvContent);
});

// NEW: Get consignee statistics
app.get('/api/consignees/stats', (req, res) => {
  if (!dataProcessed) {
    return res.status(400).json({ error: 'No data loaded' });
  }

  const stats = {
    totalConsignees: Object.keys(consigneeIndex).length,
    avgShipmentsPerConsignee: Math.round(shippingData.length / Object.keys(consigneeIndex).length),
    consigneesWithMultipleShipments: Object.values(consigneeIndex).filter(c => c.shipments.length > 1).length,
    topCommodities: {},
    topPorts: {},
    topCarriers: {}
  };

  // Calculate top commodities across all consignees
  Object.values(consigneeIndex).forEach(c => {
    c.commodities.forEach(commodity => {
      stats.topCommodities[commodity] = (stats.topCommodities[commodity] || 0) + 1;
    });
    c.ports.forEach(port => {
      stats.topPorts[port] = (stats.topPorts[port] || 0) + 1;
    });
    c.carriers.forEach(carrier => {
      stats.topCarriers[carrier] = (stats.topCarriers[carrier] || 0) + 1;
    });
  });

  // Convert to sorted arrays
  stats.topCommodities = Object.entries(stats.topCommodities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
    
  stats.topPorts = Object.entries(stats.topPorts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
    
  stats.topCarriers = Object.entries(stats.topCarriers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  res.json(stats);
});

// Original search endpoint (keep for backward compatibility)
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

// Original analytics endpoints (keep these)
app.get('/api/analytics/top-consignees', (req, res) => {
  if (!dataProcessed) {
    return res.status(400).json({ error: 'No data loaded' });
  }

  const topConsignees = Object.values(consigneeIndex)
    .map(c => ({
      name: c.name,
      shipmentCount: c.shipments.length,
      totalWeight: Math.round(c.totalWeight)
    }))
    .sort((a, b) => b.shipmentCount - a.shipmentCount)
    .slice(0, 20);

  res.json(topConsignees);
});

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

// Consignee detail endpoint
app.get('/api/consignee/:name', (req, res) => {
  if (!dataProcessed) {
    return res.status(400).json({ error: 'No data loaded' });
  }

  const consigneeName = decodeURIComponent(req.params.name);
  const consigneeData = consigneeIndex[consigneeName];

  if (!consigneeData) {
    return res.status(404).json({ error: 'Consignee not found' });
  }

  const stats = {
    name: consigneeName,
    totalShipments: consigneeData.shipments.length,
    totalWeight: Math.round(consigneeData.totalWeight),
    carriers: Array.from(consigneeData.carriers),
    commodities: Array.from(consigneeData.commodities),
    ports: Array.from(consigneeData.ports),
    recentShipments: consigneeData.shipments.slice(-10).reverse(),
    firstShipment: consigneeData.firstShipment,
    lastShipment: consigneeData.lastShipment
  };

  res.json(stats);
});

// Enhanced HTML interface with consignee browser
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Shipping Analytics - Sales Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        .navbar {
            background: white;
            padding: 15px 30px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .nav-title { font-size: 1.5em; font-weight: bold; color: #333; }
        .nav-tabs {
            display: flex;
            gap: 20px;
        }
        .nav-tab {
            padding: 8px 16px;
            background: white;
            border: 2px solid #667eea;
            color: #667eea;
            border-radius: 8px;
            cursor: pointer;
            font-size: 16px;
            font-weight: 600;
            transition: all 0.3s;
        }
                .nav-tab:hover { 
            background: #667eea;
            color: white;
            transform: translateY(-2px);
        }
        .nav-tab.active {
            background: #667eea;
            color: white;
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }
        .container { max-width: 1400px; margin: 20px auto; padding: 0 20px; }
        .content-section { display: none; }
        .content-section.active { display: block; }
        .header { background: white; padding: 30px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); margin-bottom: 30px; }
        h1 { color: #333; margin-bottom: 10px; font-size: 2.5em; }
        h2 { color: #333; margin-bottom: 20px; }
        .subtitle { color: #666; font-size: 1.1em; }
        .card { background: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
        
        /* Consignee Browser Styles */
        .filters-bar {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        .filter-group {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        .filter-label {
            font-size: 12px;
            color: #666;
            font-weight: 600;
        }
        input[type="text"], input[type="number"], select {
            padding: 10px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 14px;
        }
        .consignee-table {
            width: 100%;
            border-collapse: collapse;
        }
        .consignee-table th {
            background: #f5f5f5;
            padding: 12px;
            text-align: left;
            font-weight: 600;
            border-bottom: 2px solid #e0e0e0;
            cursor: pointer;
            user-select: none;
        }
        .consignee-table th:hover { background: #ececec; }
        .consignee-table td {
            padding: 12px;
            border-bottom: 1px solid #e0e0e0;
        }
        .consignee-table tr:hover { background: #f9f9f9; }
        .consignee-name {
            color: #667eea;
            cursor: pointer;
            font-weight: 600;
        }
        .consignee-name:hover { text-decoration: underline; }
        .pagination {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 10px;
            margin-top: 20px;
        }
        .page-btn {
            padding: 8px 12px;
            background: white;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s;
        }
        .page-btn:hover { background: #f5f5f5; }
        .page-btn.active {
            background: #667eea;
            color: white;
            border-color: #667eea;
        }
        .page-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .stat-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        .stat-value {
            font-size: 2em;
            font-weight: bold;
            margin-bottom: 5px;
        }
        .stat-label {
            font-size: 0.9em;
            opacity: 0.9;
        }
        
        /* Original styles */
        button {
    padding: 12px 24px;
    background: #667eea;
    color: white !important;
    border: 2px solid #667eea;
    border-radius: 8px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s;
}
button:hover {
    background: #5568d3;
    border-color: #5568d3;
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
}
        .analytics-card {
            background: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }
        .analytics-card h3 { color: #333; margin-bottom: 15px; font-size: 1.3em; }
        .stat-item {
            padding: 10px;
            border-bottom: 1px solid #e0e0e0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: background 0.2s;
        }
        .stat-item:hover { background: #f5f5f5; }
        .stat-item:last-child { border-bottom: none; }
        .loading { text-align: center; padding: 40px; color: #999; }
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            z-index: 1000;
        }
        .modal-content {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: white;
            padding: 30px;
            border-radius: 15px;
            max-width: 800px;
            max-height: 80vh;
            overflow-y: auto;
            width: 90%;
        }
        .close-modal {
            float: right;
            font-size: 28px;
            cursor: pointer;
            color: #999;
        }
        .close-modal:hover { color: #333; }
        .badge {
            display: inline-block;
            padding: 4px 8px;
            background: #667eea;
            color: white;
            border-radius: 4px;
            font-size: 12px;
            margin-right: 5px;
        }
        .export-btn {
            background: #28a745;
        }
        .export-btn:hover {
            background: #218838;
            transform: translateY(-2px);
        }
        .tag {
            display: inline-block;
            padding: 2px 6px;
            background: #e9ecef;
            border-radius: 4px;
            font-size: 11px;
            margin-right: 4px;
        }
    </style>
</head>
<body>
    <div class="navbar">
        <div class="nav-title">🚢 Shipping Analytics - Sales Dashboard</div>
        <div class="nav-tabs">
            <button class="nav-tab active" onclick="showSection('dashboard')">Dashboard</button>
            <button class="nav-tab" onclick="showSection('consignees')">Browse Consignees</button>
            <button class="nav-tab" onclick="showSection('search')">Search</button>
            <button class="nav-tab" onclick="showSection('upload')">Upload Data</button>
        </div>
    </div>

    <div class="container">
        <!-- Dashboard Section -->
        <div id="dashboard" class="content-section active">
            <div class="header">
                <h1>Analytics Overview</h1>
                <div class="subtitle">Quick insights from your shipping data</div>
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

        <!-- Consignees Browser Section -->
        <div id="consignees" class="content-section">
            <div class="card">
                <h2>Browse All Consignees</h2>
                <div class="subtitle">Comprehensive list for sales prospecting</div>
                
                <div class="stats-grid" id="consigneeStats">
                    <div class="stat-card">
                        <div class="stat-value">-</div>
                        <div class="stat-label">Total Consignees</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">-</div>
                        <div class="stat-label">Multi-Shipment Accounts</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">-</div>
                        <div class="stat-label">Avg Shipments</div>
                    </div>
                </div>

                <div class="filters-bar">
                    <div class="filter-group">
                        <label class="filter-label">Search Name</label>
                        <input type="text" id="consigneeSearch" placeholder="Type to search..." style="width: 200px">
                    </div>
                    <div class="filter-group">
                        <label class="filter-label">Min Shipments</label>
                        <input type="number" id="minShipments" value="0" min="0" style="width: 100px">
                    </div>
                    <div class="filter-group">
                        <label class="filter-label">Commodity Contains</label>
                        <input type="text" id="commodityFilter" placeholder="Any commodity" style="width: 150px">
                    </div>
                    <div class="filter-group">
                        <label class="filter-label">Port Contains</label>
                        <input type="text" id="portFilter" placeholder="Any port" style="width: 150px">
                    </div>
                    <div class="filter-group">
                        <label class="filter-label">Sort By</label>
                        <select id="sortBy">
                            <option value="shipmentCount">Shipment Count</option>
                            <option value="name">Name (A-Z)</option>
                            <option value="weight">Total Weight</option>
                            <option value="recent">Recent Activity</option>
                        </select>
                    </div>
                    <div class="filter-group">
                        <label class="filter-label">Order</label>
                        <select id="sortOrder">
                            <option value="desc">High to Low</option>
                            <option value="asc">Low to High</option>
                        </select>
                    </div>
                    <div class="filter-group">
                        <label class="filter-label">Per Page</label>
                        <select id="perPage">
                            <option value="25">25</option>
                            <option value="50" selected>50</option>
                            <option value="100">100</option>
                            <option value="200">200</option>
                        </select>
                    </div>
                    <div class="filter-group" style="align-self: flex-end">
                        <button onclick="applyFilters()" style="margin-bottom: 0">Apply Filters</button>
                    </div>
                    <div class="filter-group" style="align-self: flex-end">
                        <button onclick="exportConsignees()" class="export-btn" style="margin-bottom: 0">📥 Export to CSV</button>
                    </div>
                </div>

                <div id="consigneeTableContainer">
                    <table class="consignee-table">
                        <thead>
                            <tr>
                                <th onclick="sortTable('name')">Consignee Name ↕</th>
                                <th onclick="sortTable('shipmentCount')">Shipments ↕</th>
                                <th onclick="sortTable('weight')">Total Weight ↕</th>
                                <th>Top Commodities</th>
                                <th>Main Ports</th>
                                <th>Carriers</th>
                            </tr>
                        </thead>
                        <tbody id="consigneeTableBody">
                            <tr><td colspan="6" style="text-align: center">Loading...</td></tr>
                        </tbody>
                    </table>
                    
                    <div class="pagination" id="pagination"></div>
                </div>
            </div>
        </div>

        <!-- Search Section -->
        <div id="search" class="content-section">
            <div class="card">
                <h2>Search Records</h2>
                <div style="display: flex; gap: 10px; margin-bottom: 20px;">
                    <input type="text" id="searchQuery" placeholder="Search consignees, commodities, ports..." style="flex: 1">
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
        </div>

        <!-- Upload Section -->
        <div id="upload" class="content-section">
            <div class="card">
                <h2>Upload CSV Data</h2>
                <div style="background: #f0f8ff; border-left: 4px solid #667eea; padding: 10px; margin: 10px 0;">
                    Accepts .csv, .gz (gzipped CSV), or .zip files up to 100MB
                </div>
                <input type="file" id="csvFile" accept=".csv,.gz,.zip">
                <button onclick="uploadCSV()">Upload & Process</button>
                <span id="uploadStatus"></span>
            </div>
        </div>
    </div>

    <!-- Detail Modal -->
    <div id="detailModal" class="modal">
        <div class="modal-content">
            <span class="close-modal" onclick="closeModal()">&times;</span>
            <div id="modalContent"></div>
        </div>
    </div>

    <script>
        // Navigation
        function showSection(section) {
            document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            document.getElementById(section).classList.add('active');
            event.target.classList.add('active');
            
            if (section === 'consignees') {
                loadConsigneeBrowser();
                loadConsigneeStats();
            }
        }

        // Consignee Browser
        let currentPage = 1;
        let currentFilters = {};

        async function loadConsigneeBrowser(page = 1) {
            currentPage = page;
            
            const params = new URLSearchParams({
                page,
                limit: document.getElementById('perPage').value,
                sortBy: document.getElementById('sortBy').value,
                order: document.getElementById('sortOrder').value,
                minShipments: document.getElementById('minShipments').value,
                search: document.getElementById('consigneeSearch').value,
                commodity: document.getElementById('commodityFilter').value,
                port: document.getElementById('portFilter').value
            });

            try {
                const response = await fetch(\`/api/consignees/all?\${params}\`);
                const data = await response.json();
                
                if (data.consignees && data.consignees.length > 0) {
                    const tbody = document.getElementById('consigneeTableBody');
                    tbody.innerHTML = data.consignees.map(c => \`
                        <tr>
                            <td><span class="consignee-name" onclick="showConsigneeDetail('\${encodeURIComponent(c.name)}')">\${c.name}</span></td>
                            <td><strong>\${c.shipmentCount}</strong></td>
                            <td>\${c.totalWeight.toLocaleString()} kg</td>
                            <td>\${c.commodities.slice(0, 3).map(com => \`<span class="tag">\${com.substring(0, 20)}</span>\`).join('')}</td>
                            <td>\${c.ports.slice(0, 2).map(p => \`<span class="tag">\${p}</span>\`).join('')}</td>
                            <td>\${c.carriers.slice(0, 3).map(car => \`<span class="tag">\${car}</span>\`).join('')}</td>
                        </tr>
                    \`).join('');
                    
                    // Update pagination
                    updatePagination(data.page, data.totalPages, data.totalCount);
                } else {
                    document.getElementById('consigneeTableBody').innerHTML = '<tr><td colspan="6" style="text-align: center">No consignees found</td></tr>';
                    document.getElementById('pagination').innerHTML = '';
                }
            } catch (error) {
                console.error('Error loading consignees:', error);
            }
        }

        function updatePagination(currentPage, totalPages, totalCount) {
            const pagination = document.getElementById('pagination');
            let html = \`
                <button class="page-btn" onclick="loadConsigneeBrowser(1)" \${currentPage === 1 ? 'disabled' : ''}>First</button>
                <button class="page-btn" onclick="loadConsigneeBrowser(\${currentPage - 1})" \${currentPage === 1 ? 'disabled' : ''}>Prev</button>
                <span style="margin: 0 10px">Page \${currentPage} of \${totalPages} (\${totalCount} total)</span>
                <button class="page-btn" onclick="loadConsigneeBrowser(\${currentPage + 1})" \${currentPage === totalPages ? 'disabled' : ''}>Next</button>
                <button class="page-btn" onclick="loadConsigneeBrowser(\${totalPages})" \${currentPage === totalPages ? 'disabled' : ''}>Last</button>
            \`;
            pagination.innerHTML = html;
        }

        function applyFilters() {
            loadConsigneeBrowser(1);
        }

        function sortTable(field) {
            document.getElementById('sortBy').value = field;
            if (document.getElementById('sortOrder').value === 'desc') {
                document.getElementById('sortOrder').value = 'asc';
            } else {
                document.getElementById('sortOrder').value = 'desc';
            }
            loadConsigneeBrowser(currentPage);
        }

        async function loadConsigneeStats() {
            try {
                const response = await fetch('/api/consignees/stats');
                const stats = await response.json();
                
                document.getElementById('consigneeStats').innerHTML = \`
                    <div class="stat-card">
                        <div class="stat-value">\${stats.totalConsignees.toLocaleString()}</div>
                        <div class="stat-label">Total Consignees</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">\${stats.consigneesWithMultipleShipments.toLocaleString()}</div>
                        <div class="stat-label">Multi-Shipment Accounts</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">\${stats.avgShipmentsPerConsignee}</div>
                        <div class="stat-label">Avg Shipments</div>
                    </div>
                \`;
            } catch (error) {
                console.error('Error loading stats:', error);
            }
        }

        async function exportConsignees() {
            window.location.href = '/api/consignees/export';
        }

        // Original functions
        async function uploadCSV() {
            const fileInput = document.getElementById('csvFile');
            const file = fileInput.files[0];
            if (!file) {
                alert('Please select a file');
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
                        <div style="padding: 15px; border: 1px solid #e0e0e0; margin-bottom: 10px; border-radius: 8px;">
                            <strong>Consignee:</strong> \${r['Consignee'] || 'N/A'}<br>
                            <strong>Commodity:</strong> \${r['Commodity'] || 'N/A'}<br>
                            <strong>Carrier:</strong> \${r['Carrier Code'] || 'N/A'}<br>
                            <strong>Route:</strong> \${r['Foreign Port of Lading'] || 'N/A'} → \${r['US Port of Destination'] || r['US Port of Unlading'] || 'N/A'}
                        </div>
                    \`).join('')}
                \`;
            } else {
                resultsDiv.innerHTML = '<p>No results found</p>';
            }
        }

        async function loadAnalytics() {
            // Load all analytics sections
            fetch('/api/analytics/top-consignees')
                .then(r => r.json())
                .then(data => {
                    const html = data.map(c => \`
                        <div class="stat-item">
                            <span style="cursor: pointer; color: #667eea" onclick="showConsigneeDetail('\${encodeURIComponent(c.name)}')">\${c.name}</span>
                            <span style="color: #667eea; font-weight: 600">\${c.shipmentCount} shipments</span>
                        </div>
                    \`).join('');
                    document.getElementById('topConsignees').innerHTML = html;
                })
                .catch(() => {
                    document.getElementById('topConsignees').innerHTML = 'No data available';
                });

            fetch('/api/analytics/trade-lanes')
                .then(r => r.json())
                .then(data => {
                    const html = data.map(l => \`
                        <div class="stat-item">
                            <span>\${l.lane}</span>
                            <span style="color: #667eea; font-weight: 600">\${l.shipmentCount} shipments</span>
                        </div>
                    \`).join('');
                    document.getElementById('topLanes').innerHTML = html;
                })
                .catch(() => {
                    document.getElementById('topLanes').innerHTML = 'No data available';
                });

            fetch('/api/analytics/carriers')
                .then(r => r.json())
                .then(data => {
                    const html = data.map(c => \`
                        <div class="stat-item">
                            <span>\${c.carrierCode}</span>
                            <span style="color: #667eea; font-weight: 600">\${c.shipmentCount} shipments</span>
                        </div>
                    \`).join('');
                    document.getElementById('topCarriers').innerHTML = html;
                })
                .catch(() => {
                    document.getElementById('topCarriers').innerHTML = 'No data available';
                });

            fetch('/api/analytics/commodities')
                .then(r => r.json())
                .then(data => {
                    const html = data.map(c => \`
                        <div class="stat-item">
                            <span>\${c.commodity.substring(0, 40)}\${c.commodity.length > 40 ? '...' : ''}</span>
                            <span style="color: #667eea; font-weight: 600">\${c.shipmentCount} shipments</span>
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
                    <p><strong>Total Weight:</strong> \${data.totalWeight.toLocaleString()} kg</p>
                    \${data.firstShipment ? \`<p><strong>First Shipment:</strong> \${new Date(data.firstShipment).toLocaleDateString()}</p>\` : ''}
                    \${data.lastShipment ? \`<p><strong>Last Shipment:</strong> \${new Date(data.lastShipment).toLocaleDateString()}</p>\` : ''}
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

// Listen on 0.0.0.0 for Docker
app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Health check available at http://${HOST}:${PORT}/health`);
  if (dataProcessed) {
    console.log(`Data loaded: ${shippingData.length} records`);
  }
});
