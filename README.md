# Investment Tracker

A modern web application for tracking personal investments with AI-powered predictions. Built with Node.js, React, and Ollama for intelligent investment forecasting.

## Features

### 📊 Investment Management
- **Add Investments**: Track purchases with unit prices, quantities, and dates
- **Sell Units**: Record sales to maintain accurate portfolio tracking
- **Multi-Currency Support**: Automatic currency conversion using real-time exchange rates
- **Portfolio Overview**: View total invested amount vs current portfolio value
- **Detailed Statistics**: Track units by fund and platform

### 🎯 Goal Setting & Progress
- **Investment Objectives**: Set target amounts in any currency
- **Progress Tracking**: Visual progress bars showing goal completion
- **AI Predictions**: Get intelligent estimates on time to reach your goals

### 📈 Analytics & Visualization
- **Interactive Charts**: Portfolio distribution by fund or platform
- **Asset Evolution**: Track price changes over time for individual assets
- **Filtering & Pagination**: Easy navigation through investment history
- **Export Options**: Download data as JSON or Excel files

### 🤖 AI-Powered Insights
- **Llama2 Integration**: Uses Ollama's Llama2 model for predictions
- **Smart Analysis**: Considers investment patterns and frequency
- **Structured Output**: Clear, actionable time estimates

### 🎨 User Experience
- **Dark/Light Theme**: Toggle between themes for comfortable viewing
- **Responsive Design**: Works on desktop and mobile devices
- **Real-time Updates**: Live currency rates and portfolio calculations

## Technology Stack

- **Backend**: Node.js (vanilla HTTP server)
- **Frontend**: React 17 with JSX
- **AI**: Ollama with Llama2 model
- **Containerization**: Docker & Docker Compose
- **Charts**: Chart.js
- **Data Export**: SheetJS

## Prerequisites

Before running the application, ensure you have:

- **Docker** and **Docker Compose** installed on your system
- At least **4GB of available RAM** (for Ollama model loading)
- **Internet connection** (for initial model download and currency rates)

## Quick Start

### 1. Clone the Repository
```bash
git clone <repository-url>
cd investments-app
```

### 2. Start the Application
```bash
docker-compose up
```

This command will:
- Build the backend container
- Start the Ollama service with Llama2 model
- Download the Llama2 model automatically (first run only)
- Start the web application

### 3. Access the Application
Open your browser and navigate to:
```
http://localhost:3000
```

## Architecture

The application consists of three main services:

### Backend Service (`backend`)
- **Port**: 3000
- **Purpose**: REST API server and static file hosting
- **Features**:
  - Investment CRUD operations
  - Currency rate fetching
  - AI prediction orchestration
  - Data persistence (JSON file)

### Ollama Service (`ollama`)
- **Port**: 11434
- **Purpose**: AI model hosting
- **Model**: Llama2 (automatically downloaded)
- **Features**:
  - Investment prediction generation
  - Natural language processing

### Ollama Init Service (`ollama-init`)
- **Purpose**: Model initialization
- **Features**:
  - Downloads Llama2 model on first run
  - Ensures model availability before app starts

## API Endpoints

### Investments
- `GET /api/investments` - List all investments
- `POST /api/investments` - Add new investment
- `DELETE /api/investments/:id` - Delete investment

### Objectives
- `GET /api/objective` - Get current objective and progress
- `POST /api/objective` - Set/update investment objective

### Predictions
- `GET /api/prediction` - Get current prediction
- `POST /api/prediction` - Generate new prediction

### Data Management
- `GET /api/rates` - Get current exchange rates
- `POST /api/import` - Import investments from JSON

## Data Structure

### Investment Object
```json
{
  "id": "1234567890",
  "timestamp": 1234567890,
  "amount": 1000.00,
  "currency": "RON",
  "fund": "Stock XYZ",
  "platform": "Broker ABC",
  "date": "2024-01-15",
  "unitPrice": 50.00,
  "units": 20.0
}
```

### Objective Object
```json
{
  "targetAmount": 50000,
  "currency": "RON",
  "currentTotal": 25000
}
```

## Configuration

### Environment Variables
- `OLLAMA_HOST`: Ollama service hostname (default: `localhost`)
- `OLLAMA_PORT`: Ollama service port (default: `11434`)
- `PORT`: Backend server port (default: `3000`)

### Docker Compose Configuration
The application uses Docker Compose for easy deployment:

```yaml
services:
  backend:
    build: ./investments-app
    ports:
      - "3000:3000"
    environment:
      - OLLAMA_HOST=ollama
      - OLLAMA_PORT=11434
    depends_on:
      ollama:
        condition: service_healthy

  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama
    command: serve
    healthcheck:
      test: ["CMD", "ollama", "list"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  ollama-init:
    image: ollama/ollama:latest
    volumes:
      - ollama-data:/root/.ollama
    command: pull llama2
    depends_on:
      ollama:
        condition: service_healthy
```

## Usage Guide

### Adding Investments
1. Fill in the "Add Investment" form
2. Enter unit price and quantity (or total amount)
3. Select currency, fund, and platform
4. Choose the investment date
5. Click "Add"

### Setting Objectives
1. Use the "Investment Objective" form
2. Enter your target amount
3. Select the target currency
4. Click "Save Objective"

### Getting AI Predictions
1. Ensure you have investments and an objective set
2. Click "Generate Prediction" button
3. Wait for the AI analysis (spinner will show progress)
4. View the estimated time to reach your goal

### Exporting Data
- **JSON Export**: Click "Export JSON" for raw data
- **Excel Export**: Click "Export Excel" for spreadsheet format
- **Import**: Use the file input to import JSON or Excel files

## Troubleshooting

### Common Issues

**Application won't start**
- Ensure Docker and Docker Compose are installed
- Check if ports 3000 and 11434 are available
- Verify sufficient RAM (4GB+ recommended)

**Ollama model not loading**
- First run may take 5-10 minutes to download Llama2
- Check Docker logs: `docker-compose logs ollama`
- Ensure stable internet connection

**Prediction not working**
- Verify Ollama service is healthy
- Check if objective and investments are set
- Review browser console for errors

**Currency rates not updating**
- Application fetches rates from cursbnr.ro
- Rates update every 24 hours
- Check internet connectivity

### Logs and Debugging
```bash
# View all service logs
docker-compose logs

# View specific service logs
docker-compose logs backend
docker-compose logs ollama

# Follow logs in real-time
docker-compose logs -f
```

## Development

### Local Development Setup
```bash
# Install dependencies
cd investments-app/backend
npm install

# Start backend server
npm start

# Start Ollama separately
ollama serve
ollama pull llama2
```

### Project Structure
```
investments-app/
├── backend/
│   ├── server.js          # Main server file
│   ├── data.json          # Data persistence
│   ├── package.json       # Dependencies
│   └── public/
│       └── index.html     # Frontend application
├── docker-compose.yml     # Container orchestration
├── Dockerfile            # Backend container definition
└── README.md             # This file
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is open source and available under the [MIT License](LICENSE).

## Support

For issues and questions:
- Check the troubleshooting section above
- Review the logs for error messages
- Open an issue on the project repository

---

**Note**: This application is for educational and personal use. Always consult with financial advisors for investment decisions.
