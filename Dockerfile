# Étape 1: Utiliser une image Node.js officielle comme base.
# On choisit la version 20 pour rester cohérent, mais vous pourriez mettre 22, etc.
#FROM node:20-slim
FROM node:22-slim

# Étape 2: Créer le répertoire de travail dans le container
WORKDIR /usr/src/app

# Étape 3: Copier les fichiers de dépendances.
# Cette étape est séparée pour profiter du cache Docker : si ces fichiers ne changent pas,
# Docker n'aura pas à réinstaller toutes les dépendances à chaque fois.
COPY package*.json ./

# Étape 4: Installer les dépendances
RUN npm install

# Étape 5: Copier tout le reste de votre application dans le container
# (server.js, frontend/, etc.)
COPY . .

# Étape 6: Indiquer que votre application écoute sur le port 8080.
# Cloud Run fournira une variable d'environnement PORT, mais 8080 est une bonne base.
EXPOSE 8080

# Étape 7: La commande pour démarrer votre application
CMD [ "node", "server.js" ]
