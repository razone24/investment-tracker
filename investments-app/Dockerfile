FROM node:16-alpine

# Set working directory inside the container
WORKDIR /app

# Copy backend files into the container
COPY backend ./

# Expose the port the server listens on
EXPOSE 3000

# Run the application
CMD ["node", "server.js"]