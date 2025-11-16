INSERT INTO users (identifier, token, username, enabled) 
VALUES (generate_unique_identifier(), generate_unique_token(), 'Usuario Chrome Extension', true) 
RETURNING identifier, token, username;
