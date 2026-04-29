FROM node:18-bullseye

RUN sed -i 's/stable\/updates/stable-security\/updates/' /etc/apt/sources.list


RUN apt-get update

# Create app directory
WORKDIR /usr/src/app

ARG NPM_TOKEN

RUN if [ "$NPM_TOKEN" ]; \
    then RUN COPY .npmrc_ .npmrc \
    else export SOMEVAR=world; \
    fi


# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install --production

RUN rm -f .npmrc

# Bundle app source
COPY . .

EXPOSE 3000

CMD [ "npm", "start" ]



# Pobuca patch: Chat21 SDK raw Authorization header
# chat21-http-server 0.2.37 accepts the JWT as the raw Authorization header.
# @chat21/chat21-node-sdk prepends "Bearer ", which causes Unauthorized responses.
RUN sed -i "s/config.authorization = 'Bearer ' + config.token;/config.authorization = config.token;/" /usr/src/app/node_modules/@chat21/chat21-node-sdk/src/chat21.js \
 && sed -i "s/config.authorization = 'Bearer ' + token;/config.authorization = token;/" /usr/src/app/node_modules/@chat21/chat21-node-sdk/src/auth.js
